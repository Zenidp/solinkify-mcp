import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getPrepaidBalance } from '@solinkify/gate-sdk';
import type { ToolContext } from '../context.js';
import { textResult } from '../payments.js';
import { fetchSpendAuthority, spendAuthorityPda } from '../spend.js';

export function registerWalletTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wallet_status',
    {
      description:
        "Show the agent wallet: address, SOL for fees, stablecoin balances, Solinkify pre-paid balance, and today's remaining spending budget under the caps. Takes no arguments and never moves money. Call it first when a payment fails, to tell an empty wallet apart from a cap that has been reached.",
      inputSchema: {},
    },
    async () => {
      const owner = ctx.wallet.publicKey;
      const sol = (await ctx.connection.getBalance(owner)) / LAMPORTS_PER_SOL;

      const balances: Record<string, number> = {};
      for (const [symbol, mint] of Object.entries(ctx.config.mints)) {
        try {
          const r = await ctx.connection.getParsedTokenAccountsByOwner(owner, {
            mint: new PublicKey(mint),
          });
          balances[symbol] = r.value.reduce(
            (s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
            0,
          );
        } catch {
          balances[symbol] = 0;
        }
      }

      let prepaidUsdc: unknown = null;
      try {
        prepaidUsdc = await getPrepaidBalance(
          owner.toBase58(),
          ctx.config.mints['USDC'] ?? '',
          ctx.config.apiUrl,
        );
      } catch {
        /* backend unreachable — leave null */
      }

      // ADR-008 owner mode: surface the on-chain allowance next to the local caps.
      let ownerMode: unknown = null;
      if (ctx.config.ownerWallet) {
        try {
          const sa = await fetchSpendAuthority(
            ctx.connection,
            new PublicKey(ctx.config.ownerWallet),
            owner,
          );
          ownerMode = {
            owner_wallet: ctx.config.ownerWallet,
            spend_authority:
              sa ?? 'not created on-chain — the owner must call create_spend_authority',
          };
        } catch (e) {
          ownerMode = { owner_wallet: ctx.config.ownerWallet, error: String(e) };
        }
      }

      return textResult({
        address: owner.toBase58(),
        network: ctx.config.rpcUrl.includes('devnet') ? 'devnet' : 'custom/mainnet',
        sol_for_fees: sol,
        stablecoins_usd: balances,
        prepaid_usdc: prepaidUsdc,
        spending: {
          max_per_payment_usd: ctx.guard.maxPaymentUsd,
          daily_cap_usd: ctx.guard.dailyCapUsd,
          spent_today_usd: ctx.guard.spentToday(),
          remaining_today_usd: ctx.guard.remainingToday(),
        },
        // pay_checkout draws from the owner's funds when owner mode is on.
        owner_mode: ownerMode,
      });
    },
  );

  server.registerTool(
    'spend_authority_status',
    {
      description:
        "Show the on-chain SpendAuthority (ADR-008) that lets this agent pay merchants from an owner's wallet: per-payment cap, daily ceiling, what is spent/left today, and whether it has been revoked. All of it is enforced by the Solana program, not by this server. Read-only. Defaults to the SOLINKIFY_OWNER_WALLET the server is configured with.",
      inputSchema: {
        owner: z
          .string()
          .optional()
          .describe(
            'Base58 wallet address of the funds owner to inspect. Omit to use the configured SOLINKIFY_OWNER_WALLET.',
          ),
      },
    },
    async ({ owner }) => {
      const ownerStr = owner ?? ctx.config.ownerWallet;
      if (!ownerStr) {
        return textResult(
          'Owner mode is off: no SOLINKIFY_OWNER_WALLET configured and no owner argument given. ' +
            'Payments spend from the agent wallet itself.',
        );
      }
      const ownerPk = new PublicKey(ownerStr);
      const agentPk = ctx.wallet.publicKey;
      const sa = await fetchSpendAuthority(ctx.connection, ownerPk, agentPk);
      if (!sa) {
        return textResult({
          owner: ownerStr,
          agent: agentPk.toBase58(),
          spend_authority_pda: spendAuthorityPda(ownerPk, agentPk).toBase58(),
          status:
            'not created — the owner must call create_spend_authority (per-tx cap, daily cap) on-chain before delegated payments work',
        });
      }
      return textResult({
        ...sa,
        status: sa.revoked
          ? 'REVOKED — the kill switch is on; every delegated payment is rejected until the owner re-arms it with update_spend_authority'
          : 'active — pay_checkout can spend from the owner within these caps',
      });
    },
  );
}
