import type { Keypair } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { McpConfig } from './config.js';
import type { SpendGuard } from './guard.js';

export interface ToolContext {
  config: McpConfig;
  wallet: Keypair;
  connection: Connection;
  guard: SpendGuard;
}

/** Solinkify program id (identical devnet & mainnet). */
export const PROGRAM_ID =
  process.env['SOLINKIFY_PROGRAM_ID'] ?? 'A8qSJCS2uxxnEMdCcpjX2L8hUUMydoeCi5xq5qvzS22B';
