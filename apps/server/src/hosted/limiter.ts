/**
 * Failed attempts per key (a client address, an email, an account): 10 per
 * 15 minutes, plus a cap across all keys against guessing from many
 * addresses. In memory only: a restart forgets, which is fine for noise and
 * abuse control.
 */
export class LoginLimiter {
  private readonly perKey = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly perKeyMax = 10,
    private readonly globalMax = 200,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this key may try again, or 0. */
  retryAfter(key: string): number {
    const t = this.now();
    const recent = (this.perKey.get(key) ?? []).filter((x) => x > t - this.windowMs);
    this.global = this.global.filter((x) => x > t - this.windowMs);
    const blockedBy = [recent.length >= this.perKeyMax ? recent : null, this.global.length >= this.globalMax ? this.global : null].filter(
      (l): l is number[] => l !== null,
    );
    if (blockedBy.length === 0) return 0;
    const until = Math.max(...blockedBy.map((l) => l[0]! + this.windowMs));
    return Math.max(1, Math.ceil((until - t) / 1000));
  }

  fail(key: string): void {
    const t = this.now();
    const recent = (this.perKey.get(key) ?? []).filter((x) => x > t - this.windowMs);
    recent.push(t);
    this.perKey.set(key, recent);
    this.global.push(t);
    if (this.perKey.size > 10_000) this.perKey.clear();
  }

  succeed(key: string): void {
    this.perKey.delete(key);
  }
}
