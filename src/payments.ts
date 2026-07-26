import { Connection, Keypair, Transaction } from '@solana/web3.js';

/** Sign a backend-built unsigned transaction (base64) and submit it. */
export async function signAndSubmitBase64(
  connection: Connection,
  wallet: Keypair,
  txBase64: string,
): Promise<string> {
  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  tx.sign(wallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || body === null) {
    throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** Uniform MCP text result (bigint-safe — the gate SDK returns bigint units). */
export function textResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  const text =
    typeof data === 'string'
      ? data
      : JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  return { content: [{ type: 'text', text }] };
}
