import { describe, expect, test } from "bun:test";
import { selectAccount, markUsed, markRateLimited, updateCachedQuota, RATE_LIMIT_COOLDOWN_MS } from "./accounts";
import { SOFT_QUOTA_THRESHOLD, QUOTA_CACHE_TTL_MS } from "./constants";
import type { AccountsConfig } from "./types";

// Helper to build a config with N accounts
function makeConfig(count: number, overrides?: Partial<Record<string, any>>[]): AccountsConfig {
  const accounts = Array.from({ length: count }, (_, i) => ({
    email: `user${i + 1}@test.com`,
    refreshToken: `token_${i + 1}`,
    ...((overrides && overrides[i]) || {}),
  }));
  return { accounts };
}

// -- selectAccount ---------------------------------------------------------

describe("selectAccount", () => {
  test("returns null for empty accounts", () => {
    const config: AccountsConfig = { accounts: [] };
    expect(selectAccount(config)).toBeNull();
  });

  test("returns the only account when single", () => {
    const config = makeConfig(1);
    const result = selectAccount(config);
    expect(result?.email).toBe("user1@test.com");
  });

  test("returns the least-recently-used account", () => {
    const config = makeConfig(3, [
      { lastUsed: 300 },
      { lastUsed: 100 }, // oldest
      { lastUsed: 200 },
    ]);
    const result = selectAccount(config);
    expect(result?.email).toBe("user2@test.com");
  });

  test("never-used accounts (no lastUsed) get top priority", () => {
    const config = makeConfig(3, [
      { lastUsed: 100 },
      {}, // never used
      { lastUsed: 200 },
    ]);
    const result = selectAccount(config);
    expect(result?.email).toBe("user2@test.com");
  });

  test("skips rate-limited accounts", () => {
    const now = 1000;
    const config = makeConfig(3, [
      { rateLimitedUntil: now + 60000 }, // rate-limited
      { lastUsed: 500 },
      { lastUsed: 200 }, // oldest non-limited
    ]);
    const result = selectAccount(config, [], now);
    expect(result?.email).toBe("user3@test.com");
  });

  test("rate-limited accounts with expired cooldown are available", () => {
    const now = 1000;
    const config = makeConfig(2, [
      { rateLimitedUntil: now - 1 }, // expired, available again
      { lastUsed: 500 },
    ]);
    const result = selectAccount(config, [], now);
    expect(result?.email).toBe("user1@test.com");
  });

  test("skips excluded emails", () => {
    const config = makeConfig(3);
    const result = selectAccount(config, ["user1@test.com", "user2@test.com"]);
    expect(result?.email).toBe("user3@test.com");
  });

  test("returns null when all accounts are excluded", () => {
    const config = makeConfig(2);
    const result = selectAccount(config, ["user1@test.com", "user2@test.com"]);
    expect(result).toBeNull();
  });

  test("returns null when all accounts are rate-limited", () => {
    const now = 1000;
    const config = makeConfig(2, [
      { rateLimitedUntil: now + 60000 },
      { rateLimitedUntil: now + 60000 },
    ]);
    const result = selectAccount(config, [], now);
    expect(result).toBeNull();
  });

  test("round-robin: sequential calls rotate through accounts", () => {
    const config = makeConfig(3);

    // First call: all unused, picks first in array (all have lastUsed 0)
    const first = selectAccount(config);
    expect(first?.email).toBe("user1@test.com");

    // Simulate marking it used
    markUsed(config, "user1@test.com", 100);

    // Second call: user1 has lastUsed=100, user2 and user3 are still 0
    const second = selectAccount(config);
    expect(second?.email).toBe("user2@test.com");

    markUsed(config, "user2@test.com", 200);

    // Third call: user3 is still unused
    const third = selectAccount(config);
    expect(third?.email).toBe("user3@test.com");

    markUsed(config, "user3@test.com", 300);

    // Fourth call: back to user1 (oldest lastUsed)
    const fourth = selectAccount(config);
    expect(fourth?.email).toBe("user1@test.com");
  });

  test("rate-limit + exclude combo: finds next available", () => {
    const now = 1000;
    const config = makeConfig(4, [
      { lastUsed: 10 },                  // excluded
      { rateLimitedUntil: now + 60000 },  // rate-limited
      { lastUsed: 30 },                  // available, older
      { lastUsed: 20 },                  // available, oldest -> picked
    ]);
    const result = selectAccount(config, ["user1@test.com"], now);
    expect(result?.email).toBe("user4@test.com");
  });
});

// -- markUsed --------------------------------------------------------------

describe("markUsed", () => {
  test("sets lastUsed on the matching account", () => {
    const config = makeConfig(2);
    markUsed(config, "user2@test.com", 12345);
    expect(config.accounts[1].lastUsed).toBe(12345);
    expect(config.accounts[0].lastUsed).toBeUndefined();
  });

  test("does nothing for unknown email", () => {
    const config = makeConfig(1);
    markUsed(config, "unknown@test.com", 999);
    expect(config.accounts[0].lastUsed).toBeUndefined();
  });
});

// -- markRateLimited -------------------------------------------------------

describe("markRateLimited", () => {
  test("sets rateLimitedUntil with cooldown offset", () => {
    const config = makeConfig(2);
    const now = 50000;
    markRateLimited(config, "user1@test.com", now);
    expect(config.accounts[0].rateLimitedUntil).toBe(now + RATE_LIMIT_COOLDOWN_MS);
    expect(config.accounts[1].rateLimitedUntil).toBeUndefined();
  });

  test("does nothing for unknown email", () => {
    const config = makeConfig(1);
    markRateLimited(config, "unknown@test.com", 999);
    expect(config.accounts[0].rateLimitedUntil).toBeUndefined();
  });
});

// -- updateCachedQuota -----------------------------------------------------

describe("updateCachedQuota", () => {
  test("sets cachedImageQuota on the matching account", () => {
    const config = makeConfig(2);
    updateCachedQuota(config, "user1@test.com", 0.75, "2026-03-01T00:00:00Z");
    const quota = config.accounts[0].cachedImageQuota!;
    expect(quota.remainingFraction).toBe(0.75);
    expect(quota.resetTime).toBe("2026-03-01T00:00:00Z");
    expect(quota.updatedAt).toBeGreaterThan(0);
    // second account untouched
    expect(config.accounts[1].cachedImageQuota).toBeUndefined();
  });

  test("sets cachedImageQuota without resetTime", () => {
    const config = makeConfig(1);
    updateCachedQuota(config, "user1@test.com", 0.5);
    const quota = config.accounts[0].cachedImageQuota!;
    expect(quota.remainingFraction).toBe(0.5);
    expect(quota.resetTime).toBeUndefined();
  });

  test("overwrites existing cachedImageQuota", () => {
    const config = makeConfig(1, [{ cachedImageQuota: { remainingFraction: 0.9, updatedAt: 100 } }]);
    updateCachedQuota(config, "user1@test.com", 0.05);
    expect(config.accounts[0].cachedImageQuota!.remainingFraction).toBe(0.05);
  });

  test("does nothing for unknown email", () => {
    const config = makeConfig(1);
    updateCachedQuota(config, "unknown@test.com", 0.5);
    expect(config.accounts[0].cachedImageQuota).toBeUndefined();
  });
});

// -- selectAccount with soft quota -----------------------------------------

describe("selectAccount soft quota", () => {
  test("deprioritizes account with low fresh quota", () => {
    const now = Date.now();
    const freshUpdatedAt = now - 60_000; // 1 min ago — within TTL
    const config = makeConfig(2, [
      { cachedImageQuota: { remainingFraction: 0.05, updatedAt: freshUpdatedAt } }, // soft-exceeded
      { lastUsed: now - 1000 }, // normal — used recently
    ]);
    const result = selectAccount(config, [], now);
    // user2 should be preferred over user1 (soft quota exceeded)
    expect(result?.email).toBe("user2@test.com");
  });

  test("uses soft-quota-exceeded account as last resort", () => {
    const now = Date.now();
    const freshUpdatedAt = now - 60_000;
    const config = makeConfig(2, [
      { cachedImageQuota: { remainingFraction: 0.05, updatedAt: freshUpdatedAt } }, // only account
      { rateLimitedUntil: now + 60000 }, // hard rate-limited
    ]);
    const result = selectAccount(config, [], now);
    // user1 is soft-exceeded but all others unavailable → still returned
    expect(result?.email).toBe("user1@test.com");
  });

  test("treats stale quota cache as available (not soft-exceeded)", () => {
    const now = Date.now();
    const staleUpdatedAt = now - QUOTA_CACHE_TTL_MS - 1000; // expired
    const config = makeConfig(2, [
      { cachedImageQuota: { remainingFraction: 0.02, updatedAt: staleUpdatedAt } }, // stale → ignore
      { lastUsed: now - 1 },
    ]);
    // Both should be in the "available" pool since cache is stale
    const result = selectAccount(config, [], now);
    // user1 has no lastUsed (0) vs user2 lastUsed=(now-1) → user1 wins
    expect(result?.email).toBe("user1@test.com");
  });

  test("account exactly at threshold (== SOFT_QUOTA_THRESHOLD) is considered exceeded", () => {
    const now = Date.now();
    const freshUpdatedAt = now - 60_000;
    const config = makeConfig(2, [
      { cachedImageQuota: { remainingFraction: SOFT_QUOTA_THRESHOLD, updatedAt: freshUpdatedAt } },
      { lastUsed: now - 1000 },
    ]);
    const result = selectAccount(config, [], now);
    expect(result?.email).toBe("user2@test.com");
  });

  test("account just above threshold is not deprioritized", () => {
    const now = Date.now();
    const freshUpdatedAt = now - 60_000;
    const config = makeConfig(2, [
      { cachedImageQuota: { remainingFraction: SOFT_QUOTA_THRESHOLD + 0.01, updatedAt: freshUpdatedAt } },
      { lastUsed: now - 1 },
    ]);
    // user1 has no lastUsed (0), user2 has (now-1) → user1 is preferred (not soft-exceeded)
    const result = selectAccount(config, [], now);
    expect(result?.email).toBe("user1@test.com");
  });
});
