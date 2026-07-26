import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hard spending guard. An LLM holds this wallet, so every outgoing payment is
 * checked against a per-payment cap AND a daily cap. Fail-closed: if the state
 * file is unreadable, spending starts from the cap (i.e. blocked), never from 0.
 */
export class SpendGuard {
  private readonly statePath: string;
  constructor(
    readonly maxPaymentUsd: number,
    readonly dailyCapUsd: number,
    statePath?: string,
  ) {
    this.statePath = statePath ?? path.join(os.homedir(), '.solinkify', 'mcp-spend.json');
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10); // UTC day
  }

  spentToday(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as {
        date?: string;
        spentUsd?: number;
      };
      return raw.date === this.today() && typeof raw.spentUsd === 'number' ? raw.spentUsd : 0;
    } catch (err) {
      // Missing file = fresh start; anything else = fail closed.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      return this.dailyCapUsd;
    }
  }

  remainingToday(): number {
    return Math.max(0, this.dailyCapUsd - this.spentToday());
  }

  /** Throws with an agent-readable message if the payment must not happen. */
  check(amountUsd: number, label: string): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error(`Refusing ${label}: invalid amount ${amountUsd}`);
    }
    if (amountUsd > this.maxPaymentUsd) {
      throw new Error(
        `Refusing ${label}: $${amountUsd.toFixed(6)} exceeds the per-payment cap of $${this.maxPaymentUsd} (SOLINKIFY_MAX_PAYMENT_USD)`,
      );
    }
    const remaining = this.remainingToday();
    if (amountUsd > remaining) {
      throw new Error(
        `Refusing ${label}: $${amountUsd.toFixed(6)} exceeds today's remaining budget of $${remaining.toFixed(6)} (SOLINKIFY_DAILY_CAP_USD=${this.dailyCapUsd})`,
      );
    }
  }

  record(amountUsd: number): void {
    const next = { date: this.today(), spentUsd: this.spentToday() + amountUsd };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(next));
  }
}
