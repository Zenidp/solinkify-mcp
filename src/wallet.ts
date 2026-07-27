import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Load the agent wallet. Either:
 *   SOLINKIFY_WALLET_PATH — path to a JSON-array keypair file (solana-keygen), or
 *   SOLINKIFY_WALLET_BS58 — a base58-encoded secret key (wallet exports).
 * The wallet is the agent's spending identity — pair it with the spend caps.
 *
 * Called lazily, on the first tool that needs a signature. Discovery, search and
 * quote tools run without any wallet configured.
 */
export function loadWallet(): Keypair {
  const path = process.env['SOLINKIFY_WALLET_PATH'];
  if (path) {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const b58 = process.env['SOLINKIFY_WALLET_BS58'];
  if (b58) {
    return Keypair.fromSecretKey(bs58.decode(b58.trim()));
  }
  throw new Error(
    'This tool needs the agent wallet, so one must be configured: set SOLINKIFY_WALLET_PATH ' +
      '(path to a JSON keypair from `solana-keygen new`) or SOLINKIFY_WALLET_BS58 (base58 ' +
      'secret key). Discovery and search tools work without it.',
  );
}
