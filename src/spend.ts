// ADR-008 SpendAuthority client helpers (owner mode).
//
// A SpendAuthority PDA per (owner, agent) lets the agent pay merchants from
// the OWNER's wallet under program-enforced caps: per-tx cap, daily ceiling,
// and revoke as an instant kill switch. The agent never holds the owner's
// funds or keys — it only signs pay_spl_delegated transactions.

import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { PROGRAM_ID } from './context.js';

export interface SpendAuthorityState {
  address: string;
  owner: string;
  agent: string;
  token_mint: string;
  per_tx_cap_usd: number;
  daily_cap_usd: number;
  spent_today_usd: number;
  remaining_today_usd: number;
  revoked: boolean;
}

/** PDA `[spend_authority, owner, agent]` (contract spend.rs). */
export function spendAuthorityPda(owner: PublicKey, agent: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('spend_authority'), owner.toBuffer(), agent.toBuffer()],
    new PublicKey(PROGRAM_ID),
  )[0];
}

/**
 * Fetch + decode a SpendAuthority account, or null when the owner has not
 * created one. Layout (spend.rs): disc(8) ++ owner(32) ++ agent(32) ++
 * token_mint(32) ++ per_tx_cap(u64) ++ daily_cap(u64) ++ spent_today(u64) ++
 * day_index(u64) ++ revoked(u8) ++ bump(u8). All whitelisted stablecoins have
 * 6 decimals, so base units convert to USD with 1e6.
 */
export async function fetchSpendAuthority(
  connection: Connection,
  owner: PublicKey,
  agent: PublicKey,
): Promise<SpendAuthorityState | null> {
  const pda = spendAuthorityPda(owner, agent);
  const info = await connection.getAccountInfo(pda);
  if (!info || info.data.length < 138) return null;
  const d = info.data;
  const dailyCap = Number(d.readBigUInt64LE(112)) / 1e6;
  // spent_today only counts when its day_index is the CURRENT unix day —
  // after a rollover the program resets it on the next spend.
  const today = Math.floor(Date.now() / 1000 / 86_400);
  const spentToday =
    Number(d.readBigUInt64LE(128)) === today ? Number(d.readBigUInt64LE(120)) / 1e6 : 0;
  return {
    address: pda.toBase58(),
    owner: new PublicKey(d.subarray(8, 40)).toBase58(),
    agent: new PublicKey(d.subarray(40, 72)).toBase58(),
    token_mint: new PublicKey(d.subarray(72, 104)).toBase58(),
    per_tx_cap_usd: Number(d.readBigUInt64LE(104)) / 1e6,
    daily_cap_usd: dailyCap,
    spent_today_usd: spentToday,
    remaining_today_usd: Math.max(0, dailyCap - spentToday),
    revoked: d[136] !== 0,
  };
}
