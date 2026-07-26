import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { fetchJson, signAndSubmitBase64, textResult } from '../payments.js';

// Social Commerce: products shared on the X timeline as Solana Actions
// (Blinks). Same catalog + settlement rails as DataHub — these tools accept
// the LINK FORMS that actually circulate (share links, Actions URLs, raw ids).

interface BlinkMeta {
  title: string;
  description: string;
  label: string;
  icon?: string;
}

interface BookRow {
  id: string;
  title: string;
  price_sol: number; // legacy field name — value is USD stablecoin
  seller_wallet: string | null;
}

interface BlinkTx {
  transaction?: string;
  message?: string;
}

/** Accept a /book/<id> share link, an /api/actions/buy/<id> URL, or a raw id. */
function bookIdOf(input: string): string {
  const m =
    input.match(/(?:\/book\/|\/api\/actions\/buy\/)([A-Za-z0-9-]+)/) ??
    input.match(/^([A-Za-z0-9-]{16,})$/);
  if (!m?.[1]) throw new Error(`Cannot find a product id in "${input}"`);
  return m[1];
}

async function resolve(ctx: ToolContext, input: string) {
  const bookId = bookIdOf(input);
  const [meta, books] = await Promise.all([
    fetchJson<BlinkMeta>(`${ctx.config.apiUrl}/api/actions/buy/${encodeURIComponent(bookId)}`),
    fetchJson<BookRow[]>(`${ctx.config.apiUrl}/api/books`),
  ]);
  const book = books.find((b) => b.id === bookId);
  if (!book) throw new Error(`Product ${bookId} is not in the catalog.`);
  return { bookId, meta, book };
}

export function registerSocialTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'social_get_blink',
    {
      description:
        'Inspect a Solinkify Blink (a product shared on X / the timeline as a Solana Action) before buying: title, price, and seller. Accepts the share link, the Actions URL, or a raw product id.',
      inputSchema: { url: z.string() },
    },
    async ({ url }) => {
      const { bookId, meta, book } = await resolve(ctx, url);
      return textResult({
        book_id: bookId,
        title: meta.title,
        description: meta.description,
        price_usd: book.price_sol,
        seller: book.seller_wallet,
      });
    },
  );

  server.registerTool(
    'social_buy_blink',
    {
      description:
        'Buy a product from a Solinkify Blink link (as shared on X). Settles on Solana via the same escrow rails; returns the receipt and the download link. Spending caps apply.',
      inputSchema: {
        url: z.string(),
        email: z.string().email().optional(),
      },
    },
    async ({ url, email }) => {
      const { bookId, meta, book } = await resolve(ctx, url);
      const priceUsd = book.price_sol;
      ctx.guard.check(priceUsd, `social_buy_blink ${bookId}`);

      const qs = email ? `?email=${encodeURIComponent(email)}` : '';
      const blink = await fetchJson<BlinkTx>(
        `${ctx.config.apiUrl}/api/actions/buy/${encodeURIComponent(bookId)}${qs}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: ctx.wallet.publicKey.toBase58() }),
        },
      );
      if (!blink.transaction) {
        throw new Error(`Blink returned no transaction: ${blink.message ?? 'unknown error'}`);
      }

      const signature = await signAndSubmitBase64(ctx.connection, ctx.wallet, blink.transaction);
      ctx.guard.record(priceUsd);

      // Same catalog as DataHub — redeem the download link directly too.
      let download: string | null = null;
      try {
        const dl = await fetchJson<{ file_url: string | null; message: string }>(
          `${ctx.config.apiUrl}/api/verify-download`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signature, book_id: bookId }),
          },
        );
        download = dl.file_url ?? dl.message;
      } catch {
        download = email ? 'Download link will be emailed.' : null;
      }

      return textResult({
        title: meta.title,
        paid_usd: priceUsd,
        seller: book.seller_wallet,
        signature,
        download,
      });
    },
  );
}
