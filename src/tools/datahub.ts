import { createPrivateKey, sign as edSign } from 'node:crypto';
import { z } from 'zod';
import bs58 from 'bs58';
import type { Keypair } from '@solana/web3.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { subscribe } from '@solinkify/gate-sdk';
import { fetchJson, signAndSubmitBase64, textResult } from '../payments.js';
import { mintFor } from '../config.js';

// ed25519 message signing with node:crypto (no extra deps): wrap the 32-byte
// seed of the Solana keypair in a pkcs8 envelope.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signMessage(wallet: Keypair, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(wallet.secretKey.slice(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return bs58.encode(edSign(null, Buffer.from(message), key));
}

interface BookRow {
  id: string;
  title: string;
  author: string;
  price_sol: number; // legacy field name — value is USD stablecoin
  seller_wallet: string | null;
  sold_count: number;
  rating: number;
  description: string;
  category: string;
  data_format: string;
  attest_signature?: string;
  quality_score?: number | null;
  sub_enabled?: boolean;
  sub_price_usd?: number | null;
  sub_duration_secs?: number | null;
  asset_kind?: string;
  api_base_url?: string | null;
}

interface SubscriptionStatus {
  enabled: boolean;
  price_usd: number | null;
  duration_secs: number | null;
  endpoint_id: string;
  seller_wallet: string;
  expires_at: number | null;
  active: boolean;
}

interface X402Invoice {
  payment_details?: {
    transaction: string;
    amount_units: number;
    seller_address: string;
    token_mint?: string;
  };
  [k: string]: unknown;
}

interface VerifyDownloadResponse {
  status: string;
  message: string;
  file_url: string | null;
}

export function registerDatahubTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'datahub_search',
    {
      description:
        'Search the Solinkify DataHub marketplace. Returns id, title, price (USD stablecoin), seller, category, and sales count. Datasets: buy with datahub_buy. API listings (kind "api"): the price is per request — access them by calling gate_fetch on their api_base_url.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Free-text filter matched against title, author, description, category and format. Omit to browse everything. Plain keywords work best; there is no query syntax.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum number of listings to return, 1 to 50. Defaults to 10.'),
      },
    },
    async ({ query, limit }) => {
      const books = await fetchJson<BookRow[]>(`${ctx.config.apiUrl}/api/books`);
      const q = query?.toLowerCase();
      const rows = books
        .filter(
          (b) =>
            !q ||
            [b.title, b.author, b.description, b.category, b.data_format]
              .join(' ')
              .toLowerCase()
              .includes(q),
        )
        .slice(0, limit)
        .map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author,
          price_usd: b.price_sol,
          category: b.category,
          format: b.data_format,
          sold: b.sold_count,
          rating: b.rating,
          quality_score: b.quality_score ?? null,
          attested: Boolean(b.attest_signature),
          subscription: b.sub_enabled
            ? { price_usd: b.sub_price_usd ?? null, duration_secs: b.sub_duration_secs ?? null }
            : null,
          kind: b.asset_kind || 'dataset',
          // For "api" listings: gate_fetch this URL (x402 pay-per-request).
          api_base_url: b.api_base_url ?? null,
        }));
      return textResult({ total_matches: rows.length, datasets: rows });
    },
  );

  server.registerTool(
    'datahub_buy',
    {
      description:
        'Buy a DataHub dataset (x402 settlement on Solana, 99% goes to the seller) and return the download link. Pays in USDC by default; set token to USDT to settle in USDT instead. Spending caps apply.',
      inputSchema: {
        book_id: z
          .string()
          .describe(
            'The dataset id returned by datahub_search (a uuid), not its title. Buying the same dataset twice pays twice; use datahub_download to re-fetch something already owned.',
          ),
        // PYUSD is whitelisted on-chain but is a Token-2022 mint that pay_spl
        // (classic SPL only) cannot settle yet — pre-mainnet contract item.
        token: z
          .enum(['USDC', 'USDT'])
          .default('USDC')
          .describe(
            'Stablecoin to pay with. The agent wallet must hold this token and a little SOL for fees. Defaults to USDC.',
          ),
      },
    },
    async ({ book_id, token }) => {
      mintFor(ctx.config, token); // fail fast if the cluster has no mint for it
      // The x402 invoice endpoint answers HTTP 402 BY DESIGN — read it raw.
      const invRes = await fetch(
        `${ctx.config.apiUrl}/api/x402/book/${encodeURIComponent(book_id)}?buyer=${ctx.wallet.publicKey.toBase58()}&token_mint=${token}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const invoice = (await invRes.json().catch(() => null)) as X402Invoice | null;
      const pd = invoice?.payment_details;
      if (!pd?.transaction) {
        throw new Error(`No payable invoice returned: ${JSON.stringify(invoice).slice(0, 300)}`);
      }
      const priceUsd = pd.amount_units / 1e6;
      ctx.guard.check(priceUsd, `datahub_buy ${book_id}`);

      const signature = await signAndSubmitBase64(ctx.connection, ctx.wallet, pd.transaction);
      ctx.guard.record(priceUsd);

      const dl = await fetchJson<VerifyDownloadResponse>(
        `${ctx.config.apiUrl}/api/verify-download`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, book_id }),
        },
      );
      return textResult({
        paid_usd: priceUsd,
        token,
        token_mint: pd.token_mint ?? null,
        seller: pd.seller_address,
        signature,
        download: dl.file_url ?? dl.message,
      });
    },
  );

  server.registerTool(
    'datahub_review',
    {
      description:
        'Rate a DataHub dataset you have purchased (1-5 stars, optional comment). Verified-purchase only: the marketplace rejects wallets without a receipt for the dataset. No payment involved.',
      inputSchema: {
        book_id: z
          .string()
          .describe('Id of a dataset this wallet has already bought. Reviewing without a purchase receipt is rejected.'),
        rating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe('Star rating from 1 (worst) to 5 (best), whole numbers only.'),
        comment: z
          .string()
          .max(2000)
          .optional()
          .describe('Optional review text, up to 2000 characters. Published publicly next to the rating.'),
      },
    },
    async ({ book_id, rating, comment }) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signMessage(ctx.wallet, `solinkify-review:${book_id}:${timestamp}`);
      await fetchJson<{ status: string }>(
        `${ctx.config.apiUrl}/api/datahub/reviews/${encodeURIComponent(book_id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reviewer_pubkey: ctx.wallet.publicKey.toBase58(),
            rating,
            body: comment ?? '',
            signature,
            timestamp,
          }),
        },
      );
      const summary = await fetchJson<{ summary: { average: number; count: number } }>(
        `${ctx.config.apiUrl}/api/datahub/reviews/${encodeURIComponent(book_id)}`,
      );
      return textResult({
        status: 'review published',
        book_id,
        your_rating: rating,
        asset_average: summary.summary.average,
        asset_review_count: summary.summary.count,
      });
    },
  );

  server.registerTool(
    'datahub_subscribe',
    {
      description:
        "Subscribe to a recurring DataHub dataset (time-based access, on-chain payment with the plan's USDC price). While active, every update of the dataset can be fetched with datahub_download — no per-download payment. Renewing extends from the current expiry. Spending caps apply.",
      inputSchema: {
        book_id: z
          .string()
          .describe(
            'Id of a dataset that offers a subscription plan. datahub_search reports one under "subscription"; datasets without a plan must be bought with datahub_buy instead.',
          ),
      },
    },
    async ({ book_id }) => {
      const plan = await fetchJson<SubscriptionStatus>(
        `${ctx.config.apiUrl}/api/datahub/subscription/${encodeURIComponent(book_id)}`,
      );
      if (!plan.enabled || plan.price_usd == null) {
        throw new Error('This dataset has no active subscription plan — use datahub_buy instead.');
      }
      ctx.guard.check(plan.price_usd, `datahub_subscribe ${book_id}`);
      const res = await subscribe({
        wallet: ctx.wallet,
        rpcUrl: ctx.config.rpcUrl,
        apiUrl: ctx.config.apiUrl,
        creatorWallet: plan.seller_wallet,
        endpointId: plan.endpoint_id,
      });
      ctx.guard.record(plan.price_usd);
      return textResult({
        status: 'subscribed',
        book_id,
        price_usd: plan.price_usd,
        signature: res.signature,
        expires_at: new Date(res.expiresAt * 1000).toISOString(),
        next: 'call datahub_download with this book_id to fetch the file',
      });
    },
  );

  server.registerTool(
    'datahub_download',
    {
      description:
        'Fetch a fresh download link for a DataHub dataset the agent already owns, either from a past purchase receipt or an active subscription. Proves ownership with a signed wallet message. Costs nothing, so prefer it over buying the same dataset again.',
      inputSchema: {
        book_id: z
          .string()
          .describe(
            'Id of a dataset this wallet already owns through datahub_buy or datahub_subscribe. Fails if there is no receipt and no active subscription.',
          ),
      },
    },
    async ({ book_id }) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signMessage(ctx.wallet, `solinkify-redownload:${book_id}:${timestamp}`);
      const res = await fetchJson<{ status: string; file_url: string }>(
        `${ctx.config.apiUrl}/api/datahub/redownload/${encodeURIComponent(book_id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            buyer_pubkey: ctx.wallet.publicKey.toBase58(),
            signature,
            timestamp,
          }),
        },
      );
      return textResult({ book_id, download: res.file_url });
    },
  );
}
