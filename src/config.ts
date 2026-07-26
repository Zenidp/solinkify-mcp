// Environment-driven configuration. Devnet defaults; every value can be
// overridden for the mainnet switch (same pattern as the other SDKs).

export interface McpConfig {
  rpcUrl: string;
  apiUrl: string;
  /** symbol → mint address for the active cluster */
  mints: Record<string, string>;
  /** hard cap for a single payment, in USD stablecoin */
  maxPaymentUsd: number;
  /** hard cap for total spend per UTC day, in USD stablecoin */
  dailyCapUsd: number;
}

const DEVNET_MINTS: Record<string, string> = {
  USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  USDT: 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4DYPzVaS',
  PYUSD: 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM',
};

const MAINNET_MINTS: Record<string, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(): McpConfig {
  const mainnet = process.env['SOLINKIFY_NETWORK'] === 'mainnet-beta';
  return {
    rpcUrl:
      process.env['SOLANA_RPC_URL'] ??
      (mainnet ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'),
    apiUrl: process.env['SOLINKIFY_API_URL'] ?? 'https://api.solinkify.com',
    mints: mainnet ? MAINNET_MINTS : DEVNET_MINTS,
    maxPaymentUsd: num('SOLINKIFY_MAX_PAYMENT_USD', 1),
    dailyCapUsd: num('SOLINKIFY_DAILY_CAP_USD', 10),
  };
}

export function mintFor(config: McpConfig, symbol: string): string {
  const mint = config.mints[symbol.toUpperCase()];
  if (!mint) {
    throw new Error(
      `Unknown token "${symbol}" — supported: ${Object.keys(config.mints).join(', ')}`,
    );
  }
  return mint;
}
