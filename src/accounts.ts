import type { AccountsConfig, Account } from "./types";
import { SOFT_QUOTA_THRESHOLD, QUOTA_CACHE_TTL_MS } from "./constants";

export const MAX_RETRIES = 3;
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ── Soft quota helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the account's cached quota is below the soft threshold AND
 * the cache is still fresh. Stale cache = treat as available (we don't know).
 */
function isSoftQuotaExceeded(account: Account): boolean {
  const quota = account.cachedImageQuota;
  if (!quota) return false;
  if (Date.now() - quota.updatedAt > QUOTA_CACHE_TTL_MS) return false; // stale → assume ok
  return quota.remainingFraction <= SOFT_QUOTA_THRESHOLD;
}

// ── Account selection ─────────────────────────────────────────────────────────

/**
 * Select the least-recently-used account that is not rate-limited or excluded.
 * Accounts with soft-quota exceeded are deprioritized but still used as last resort.
 * Returns null if no account is available.
 */
export function selectAccount(
  config: AccountsConfig,
  excludeEmails: string[] = [],
  now: number = Date.now()
): Account | null {
  const available: Account[] = [];
  const softQuotaExceeded: Account[] = [];

  for (const a of config.accounts) {
    if (excludeEmails.includes(a.email)) continue;
    if (a.rateLimitedUntil && a.rateLimitedUntil > now) continue;

    if (isSoftQuotaExceeded(a)) {
      softQuotaExceeded.push(a);
    } else {
      available.push(a);
    }
  }

  // Prefer accounts with quota headroom
  const pool = available.length > 0 ? available : softQuotaExceeded;
  if (pool.length === 0) return null;

  // Least recently used first (never-used accounts get top priority)
  pool.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return pool[0];
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

/**
 * Mark an account as recently used (mutates in place).
 */
export function markUsed(config: AccountsConfig, email: string, now: number = Date.now()): void {
  const account = config.accounts.find((a) => a.email === email);
  if (account) {
    account.lastUsed = now;
  }
}

/**
 * Mark an account as rate-limited with a cooldown (mutates in place).
 */
export function markRateLimited(
  config: AccountsConfig,
  email: string,
  now: number = Date.now()
): void {
  const account = config.accounts.find((a) => a.email === email);
  if (account) {
    account.rateLimitedUntil = now + RATE_LIMIT_COOLDOWN_MS;
  }
}

/**
 * Update the cached quota fraction for an account (mutates in place).
 * Called after a successful generation to keep soft quota logic accurate.
 */
export function updateCachedQuota(
  config: AccountsConfig,
  email: string,
  remainingFraction: number,
  resetTime?: string
): void {
  const account = config.accounts.find((a) => a.email === email);
  if (account) {
    account.cachedImageQuota = {
      remainingFraction,
      resetTime,
      updatedAt: Date.now(),
    };
  }
}

