// Simple per-toolset token-bucket client-side rate limiter.
// Feishu's official SDK doesn't throttle; LLM loops can blow up tenant quotas quickly.
// These are conservative defaults — tune via LARK_THROTTLE_<TOOLSET>_RPS env vars if needed.

import type { Toolset } from '../toolsets.js';
import { logger } from '../log.js';

interface Bucket {
  capacity: number;       // tokens
  refillPerSec: number;   // tokens/sec
  tokens: number;
  lastRefill: number;     // ms epoch
}

const DEFAULT_LIMITS: Record<Toolset, { rps: number; burst: number }> = {
  messaging: { rps: 50, burst: 10 },
  bitable: { rps: 10, burst: 5 },
  docs: { rps: 20, burst: 5 },
  calendar: { rps: 20, burst: 5 },
  other: { rps: 20, burst: 5 },
};

function readEnvRps(toolset: Toolset, fallback: number): number {
  const key = `LARK_THROTTLE_${toolset.toUpperCase()}_RPS`;
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const buckets = new Map<Toolset, Bucket>();

function getBucket(toolset: Toolset): Bucket {
  let b = buckets.get(toolset);
  if (b) return b;
  const base = DEFAULT_LIMITS[toolset] ?? DEFAULT_LIMITS.other;
  const rps = readEnvRps(toolset, base.rps);
  b = {
    capacity: Math.max(1, base.burst),
    refillPerSec: rps,
    tokens: Math.max(1, base.burst),
    lastRefill: Date.now(),
  };
  buckets.set(toolset, b);
  return b;
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed <= 0) return;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec);
  b.lastRefill = now;
}

export async function throttle(toolset: Toolset): Promise<void> {
  const b = getBucket(toolset);
  refill(b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  // Wait for 1 token to refill; cap wait to 5s then reject to avoid LLM-loop hangs.
  const needed = 1 - b.tokens;
  const waitMs = Math.ceil((needed / b.refillPerSec) * 1000);
  if (waitMs > 5000) {
    logger.warn({ toolset, waitMs }, 'rate limited (client-side)');
    throw Object.assign(new Error(`rate limited (client-side) for toolset=${toolset}`), {
      code: 99991400,
    });
  }
  await new Promise((r) => setTimeout(r, waitMs));
  refill(b);
  b.tokens = Math.max(0, b.tokens - 1);
}
