import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getPrepaidBalance } from '@solinkify/gate-sdk';
import type { ToolContext } from '../context.js';
import { textResult } from '../payments.js';

export function registerWalletTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'wallet_status',
    {
      description:
        "Show the agent wallet: address, SOL for fees, stablecoin balances, Solinkify pre-paid balance, and today's remaining spending budget.",
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
      });
    },
  );
}
