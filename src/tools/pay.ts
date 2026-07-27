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
        'Inspect a Solinkify Pay checkout session (from a merchant store such as WooCommerce, OpenCart or PrestaShop) before paying: amount, merchant, order id, and status. Read-only, so call it first to confirm what pay_checkout would spend.',
      inputSchema: {
        session: z
          .string()
          .describe(
            'Either the session id (a uuid) or the full checkout URL such as https://solinkify.com/checkout/<id>. Both forms are accepted; the id is extracted from the URL.',
          ),
      },
    },
    async ({ session }) => textResult(summarize(await getSession(ctx, session))),
  );

  server.registerTool(
    'pay_checkout',
    {
      description:
        'Pay a pending Solinkify Pay checkout session. Settles on Solana, the merchant receives 99% instantly, and the order is marked paid. Spends from the agent wallet — or, when SOLINKIFY_OWNER_WALLET is configured, from the owner wallet under its on-chain SpendAuthority caps (ADR-008); check spend_authority_status first in that mode. Moves money and is not reversible, so confirm the amount with pay_get_session first. Sessions that are already paid or expired are refused.',
      inputSchema: {
        session: z
          .string()
          .describe(
            'Session id (uuid) or full checkout URL of a session whose status is still "pending". The amount and token are fixed by the merchant and cannot be overridden here.',
          ),
      },
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
          // ADR-008 owner mode: draw from the owner's ATA via pay_spl_delegated
          // (the contract enforces the SpendAuthority caps + kill switch).
          owner_wallet: ctx.config.ownerWallet,
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
        funds_source: ctx.config.ownerWallet
          ? `owner wallet ${ctx.config.ownerWallet} (delegated, on-chain caps)`
          : 'agent wallet',
        route: gw.route_path ?? null,
        signature,
        verify,
      });
    },
  );
}
