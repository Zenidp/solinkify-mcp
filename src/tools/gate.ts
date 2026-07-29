import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicKey } from '@solana/web3.js';
import {
  GateClient,
  depositPrepaid,
  getPrepaidBalance,
  subscribe,
  fileDeliveryReceipt,
  getDeliveryRecord,
} from '@solinkify/gate-sdk';
import { mintFor } from '../config.js';
import { PROGRAM_ID, type ToolContext } from '../context.js';
import { fetchJson, textResult } from '../payments.js';

interface Manifest {
  price?: number;
  currency?: string;
  access_modes?: unknown;
  /** Set when the gate files its own hash of what it served. */
  delivery_records?: boolean;
  payment?: { escrow_address?: string; endpoint_id?: string };
  [k: string]: unknown;
}

/** Ethical agents self-identify. The default UA contains a token every Gate
 *  bot-detector tier recognizes, so gated sites answer 402 instead of being
 *  scraped for free — override with SOLINKIFY_USER_AGENT if needed. */
const USER_AGENT =
  process.env['SOLINKIFY_USER_AGENT'] ??
  'solinkify-mcp/0.1 (autonomous AI agent; GPTBot-compatible; +https://solinkify.com/gate)';

/** Fetch a URL expecting the x402 manifest; null when the URL is not gated. */
async function peekManifest(url: string): Promise<{ status: number; manifest: Manifest | null }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 402) return { status: res.status, manifest: null };
  const manifest = (await res.json().catch(() => null)) as Manifest | null;
  return { status: 402, manifest };
}

/** One entry of the public x402 resource registry (GET /api/x402/resources). */
interface RegistryResource {
  title: string;
  provider: string;
  description: string;
  category: string;
  tags: string[];
  url: string;
  price_usd: number;
  currency: string;
  token_mint: string;
  network: string;
  endpoint_id: string;
  pay_to: string;
  access_modes: string[];
  verified_at: string;
}

export function registerGateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'gate_find_endpoints',
    {
      description:
        'Browse the public Solinkify registry of x402-priced endpoints: paid APIs and content an agent can buy per request. Returns url, price per request, currency, network and access modes for each one, plus whether it fits the configured spending caps. Use it to find a paid data source without being handed the URL, then call gate_get_price or gate_fetch on the url. Read-only and free. Every entry was verified by machine: it answers a real HTTP 402 with a valid x402 manifest that pays the wallet which listed it.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Free-text filter matched against title, description and tags. Omit to list everything. Plain keywords work best; there is no query syntax.',
          ),
        max_price_usd: z
          .number()
          .positive()
          .optional()
          .describe(
            'Drop endpoints priced above this many USD per request. Omit to see every price.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of endpoints to return, 1 to 100. Defaults to 20.'),
      },
    },
    async ({ query, max_price_usd, limit }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (query) params.set('q', query);
      const registry = await fetchJson<{ count: number; resources: RegistryResource[] }>(
        `${ctx.config.apiUrl}/api/x402/resources?${params.toString()}`,
      );
      const resources = (registry.resources ?? []).filter(
        (r) => max_price_usd === undefined || r.price_usd <= max_price_usd,
      );
      return textResult({
        total_matches: resources.length,
        endpoints: resources.map((r) => ({
          title: r.title,
          provider: r.provider,
          description: r.description,
          category: r.category,
          tags: r.tags,
          url: r.url,
          price_usd: r.price_usd,
          currency: r.currency,
          network: r.network,
          access_modes: r.access_modes,
          verified_at: r.verified_at,
          // The per-payment cap is what would actually veto gate_fetch.
          within_spending_cap: r.price_usd <= ctx.config.maxPaymentUsd,
        })),
      });
    },
  );

  server.registerTool(
    'gate_get_price',
    {
      description:
        'Preview a Solinkify Gate paywall (HTTP 402 / x402) without paying: price, currency, and available access modes (pay-per-request, prepaid, subscription). Call this before gate_fetch to learn the price. Costs nothing and never moves money.',
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            'Absolute https:// URL of the gated page or API endpoint to inspect, e.g. https://example.com/api/report. If the URL is not paywalled the tool says so instead of returning a price.',
          ),
      },
    },
    async ({ url }) => {
      const { status, manifest } = await peekManifest(url);
      if (status !== 402) return textResult(`Not gated — the URL answered HTTP ${status}.`);
      return textResult(manifest ?? 'HTTP 402 without a readable manifest.');
    },
  );

  server.registerTool(
    'gate_fetch',
    {
      description:
        'Fetch a Gate-protected URL, automatically paying the x402 paywall from the agent wallet (prepaid balance preferred, escrow payment otherwise). Returns the page content plus what was paid. Refuses and explains if the price exceeds the per-payment or daily cap. Ungated URLs are fetched normally and cost nothing.',
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            'Absolute https:// URL to retrieve. If it answers HTTP 402 the paywall is paid automatically, so check the price with gate_get_price first when the cost matters.',
          ),
      },
    },
    async ({ url }) => {
      // Read the price first so the guard can veto before any money moves.
      const { status, manifest } = await peekManifest(url);
      const price = manifest?.price ?? 0;
      if (status === 402) ctx.guard.check(price, `gate_fetch ${url}`);

      const client = new GateClient({
        wallet: ctx.wallet,
        rpcUrl: ctx.config.rpcUrl,
        apiUrl: ctx.config.apiUrl,
        maxPricePerRequest: ctx.config.maxPaymentUsd,
      });
      const result = await client.fetchProtected(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      // Read bytes, not text: the delivery hash has to cover exactly what
      // arrived, and a re-encode would change it.
      const bytes = Buffer.from(await result.response.arrayBuffer());
      const body = bytes.toString('utf8');
      if (result.via) ctx.guard.record(price);

      // File the agent side when the gate says it files its own. Doing it here
      // is the only chance: the bytes are gone once this tool returns, and a
      // record cannot be reconstructed after the fact.
      let delivery: Record<string, unknown> | null = null;
      const creatorWallet = manifest?.payment?.escrow_address;
      if (result.via === 'payment' && result.paymentId && manifest?.delivery_records && creatorWallet) {
        const filed = await fileDeliveryReceipt({
          wallet: ctx.wallet,
          paymentId: result.paymentId,
          creatorWallet,
          content: bytes,
          apiUrl: ctx.config.apiUrl,
        });
        delivery = {
          content_sha256: filed.contentSha256,
          recorded: filed.recorded,
          ...(filed.error ? { error: filed.error } : {}),
        };
      }

      return textResult({
        http_status: result.response.status,
        paid: result.via ?? 'none',
        price_usd: result.via ? price : 0,
        payment_id: result.paymentId ?? null,
        ...(delivery ? { delivery_record: delivery } : {}),
        content: body.length > 40_000 ? `${body.slice(0, 40_000)}… [truncated]` : body,
      });
    },
  );

  server.registerTool(
    'gate_check_delivery',
    {
      description:
        'Check what each side says was delivered for a payment: the hash the gate filed for what it served, and the hash the agent filed for what it received. Use it to confirm a purchase arrived intact, or to show a discrepancy. Read-only and free. Note it records WHICH bytes were delivered, not whether their contents were correct.',
      inputSchema: {
        payment_id: z
          .string()
          .describe(
            'The payment id returned by gate_fetch. Only payments settled through an escrow have one; prepaid and subscription access do not.',
          ),
      },
    },
    async ({ payment_id }) => {
      const record = await getDeliveryRecord(payment_id, ctx.config.apiUrl);
      const verdict =
        record.match === true
          ? 'both sides recorded the same content'
          : record.match === false
            ? 'THE TWO SIDES DISAGREE about what was delivered'
            : 'only one side has filed so far, nothing to compare yet';
      return textResult({ ...record, verdict });
    },
  );

  server.registerTool(
    'gate_prepaid_balance',
    {
      description:
        "Show the agent's Solinkify pre-paid balance for a stablecoin (deposited once, then debited per request without signing a transaction each time). Read-only.",
      inputSchema: {
        token: z
          .enum(['USDC', 'USDT'])
          .default('USDC')
          .describe(
            'Stablecoin whose pre-paid balance to read. Balances are tracked per token, so USDC and USDT are separate pots. Defaults to USDC.',
          ),
      },
    },
    async ({ token }) => {
      const info = await getPrepaidBalance(
        ctx.wallet.publicKey.toBase58(),
        mintFor(ctx.config, token),
        ctx.config.apiUrl,
      );
      return textResult(info);
    },
  );

  server.registerTool(
    'gate_prepaid_deposit',
    {
      description:
        'Deposit stablecoin into the Solinkify pre-paid balance so future gate_fetch calls debit it without a per-request transaction. Moves money: the full deposit counts against the daily spending cap at once, and the balance can be withdrawn later.',
      inputSchema: {
        amount_usd: z
          .number()
          .positive()
          .describe(
            'Amount to deposit, in whole currency units (1.5 means $1.50, not 1500000 base units). Must be positive and within the remaining daily cap.',
          ),
        token: z
          .enum(['USDC', 'USDT'])
          .default('USDC')
          .describe(
            'Stablecoin to deposit. Must match the token the target endpoints price in, since balances do not convert between tokens. Defaults to USDC.',
          ),
      },
    },
    async ({ amount_usd, token }) => {
      ctx.guard.check(amount_usd, 'gate_prepaid_deposit');
      const res = await depositPrepaid(
        { wallet: ctx.wallet, rpcUrl: ctx.config.rpcUrl, apiUrl: ctx.config.apiUrl },
        mintFor(ctx.config, token),
        Math.round(amount_usd * 1e6),
      );
      ctx.guard.record(amount_usd);
      return textResult({ deposited_usd: amount_usd, token, ...res });
    },
  );

  server.registerTool(
    'gate_subscribe',
    {
      description:
        "Buy (or renew) a creator's subscription plan for a Gate endpoint: one payment, then unlimited access until expiry. Moves money. The plan price is read on-chain and checked against the spending caps before paying. Fails if the endpoint has no subscription plan.",
      inputSchema: {
        creator_wallet: z
          .string()
          .describe(
            "The creator's Solana wallet address in base58 (the endpoint owner, not the agent's own wallet). Shown in the 402 manifest returned by gate_get_price.",
          ),
        endpoint_id: z
          .string()
          .describe(
            'Identifier the creator gave the endpoint, e.g. "premium-api". Also comes from the 402 manifest; it is not a URL.',
          ),
      },
    },
    async ({ creator_wallet, endpoint_id }) => {
      // Pre-read the plan price so the guard can veto before paying.
      const programId = new PublicKey(PROGRAM_ID);
      const [endpointPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('gate_endpoint'), new PublicKey(creator_wallet).toBuffer(), Buffer.from(endpoint_id)],
        programId,
      );
      const [planPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('gate_subplan'), endpointPda.toBuffer()],
        programId,
      );
      const plan = await ctx.connection.getAccountInfo(planPda);
      if (!plan) throw new Error('No subscription plan exists for this endpoint.');
      // SubscriptionPlan: disc(8) + endpoint(32) + price u64 LE at offset 40.
      const priceUsd = Number(plan.data.readBigUInt64LE(40)) / 1e6;
      ctx.guard.check(priceUsd, `gate_subscribe ${endpoint_id}`);

      const res = await subscribe({
        wallet: ctx.wallet,
        rpcUrl: ctx.config.rpcUrl,
        apiUrl: ctx.config.apiUrl,
        creatorWallet: creator_wallet,
        endpointId: endpoint_id,
      });
      ctx.guard.record(priceUsd);
      return textResult({
        price_usd: priceUsd,
        signature: res.signature,
        expires_at: new Date(res.expiresAt * 1000).toISOString(),
      });
    },
  );
}
