/**
 * Small, self-contained sliding-window rate limiter for this extension's
 * safe-routing.evaluate gateway method. Deliberately not a reuse of
 * src/gateway/control-plane-rate-limit.ts: that mechanism is wired through
 * Core's control-plane-write method classification, and reusing it here
 * would mean growing the plugin-sdk's narrow, CI-gated export surface for a
 * single Phase 1 shadow-evaluation method.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
/** Hard cap on distinct tracked keys to bound memory from unique-key growth. */
const MAX_TRACKED_KEYS = 1_000;

type Bucket = {
  count: number;
  windowStartMs: number;
};

const buckets = new Map<string, Bucket>();

/** Consumes one budget unit for `key`'s current sliding window. */
export function consumeShadowEvaluateBudget(
  key: string,
  nowMs = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  const bucket = buckets.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= WINDOW_MS) {
    if (!buckets.has(key) && buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) {
        buckets.delete(oldest);
      }
    }
    buckets.set(key, { count: 1, windowStartMs: nowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, bucket.windowStartMs + WINDOW_MS - nowMs),
    };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

const testing = {
  reset(): void {
    buckets.clear();
  },
};
export { testing as __testing };
