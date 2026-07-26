import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import { fetchJson, signAndSubmitBase64, textResult } from '../payments.js';

interface Session {
  id: string;
  merchant_wallet: string;
  amount_units: number;
  token_mint: string;
  order_id: string;
  status: 'pending' | 'paid' | 'expired';
  metadata?: { display_amount?: number; display_currency?: string } | null;
}

interface GatewayTx {
  status: string;
  message?: string;
  transaction_base64?: string;
  route_path?: string;
}

/** Accept a raw session id or a full checkout URL (…/checkout/<id>). */
function sessionIdOf(input: string): string {
  const m = input.match(/checkout\/([A-Za-z0-9-]+)/);
  return m?.[1] ?? input.trim();
}

async function getSession(ctx: ToolContext, input: string): Promise<Session> {
  const id = sessionIdOf(input);
  const res = await fetchJson<{ session: Session }>(
    `${ctx.config.apiUrl}/api/gateway/session/${encodeURIComponent(id)}`,
  );
  return res.session;
}

function summarize(s: Session) {
  return {
    session_id: s.id,
    order_id: s.order_id,
    merchant: s.merchant_wallet,
    amount_usd: s.amount_units / 1e6,
    token: s.token_mint,
    status: s.status,
    original_price:
      s.metadata?.display_currency && s.metadata.display_currency !== 'USD'
        ? `${s.metadata.display_amount} ${s.metadata.display_currency}`
        : null,
  };
}

export function registerPayTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'pay_get_session',
    {
      description:
        'Inspect a Solinkify Pay checkout session (from a merchant store such as WooCommerce/OpenCart/PrestaShop) before paying: amount, merchant, order id, and status. Accepts a session id or a full checkout URL.',
      inputSchema: { session: z.string() },
    },
    async ({ session }) => textResult(summarize(await getSession(ctx, session))),
  );

  server.registerTool(
    'pay_checkout',
    {
      description:
        'Pay a pending Solinkify Pay checkout session from the agent wallet (settles on Solana; the merchant receives 99% instantly and the order is marked paid). Spending caps apply.',
      inputSchema: { session: z.string() },
    },
    async ({ session }) => {
      const s = await getSession(ctx, session);
      if (s.status !== 'pending') {
        throw new Error(`Session is "${s.status}" — only pending sessions can be paid.`);
      }
      const amountUsd = s.amount_units / 1e6;
      ctx.guard.check(amountUsd, `pay_checkout ${s.order_id}`);

      const gw = await fetchJson<GatewayTx>(`${ctx.config.apiUrl}/api/gateway/create-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyer_wallet: ctx.wallet.publicKey.toBase58(),
          merchant_wallet: s.merchant_wallet,
          amount_sol: amountUsd,
          order_id: s.order_id,
          token_mint: s.token_mint,
        }),
      });
      if (gw.status !== 'success' || !gw.transaction_base64) {
        throw new Error(`Gateway refused the payment: ${gw.message ?? 'unknown error'}`);
      }

      const signature = await signAndSubmitBase64(ctx.connection, ctx.wallet, gw.transaction_base64);
      ctx.guard.record(amountUsd);

      const verify = await fetchJson<Record<string, unknown>>(
        `${ctx.config.apiUrl}/api/gateway/session/${encodeURIComponent(s.id)}/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buyer_wallet: ctx.wallet.publicKey.toBase58(), signature }),
        },
      );
      return textResult({
        ...summarize(await getSession(ctx, s.id)),
        paid_usd: amountUsd,
        route: gw.route_path ?? null,
        signature,
        verify,
      });
    },
  );
}
