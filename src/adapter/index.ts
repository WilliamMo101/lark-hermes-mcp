// Adapter entry — merges two tool sources into a single UnifiedSpec map:
//   1. fallback.ts    — hand-written zod-based tools (tenant-token, ~13 tools)
//   2. shim.ts        — loads 36 native OpenClaw tools via @larksuite/openclaw-lark
//
// The server layer consumes only UnifiedSpec, so adding/removing sources here
// is transparent to server.ts.

import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { getAllTools as getFallbackTools, type ToolSpec as FallbackSpec } from './fallback.js';
import { loadShimTools } from './shim.js';
import { getOAuthTools } from './oauth-tools.js';
import type { UnifiedSpec, ValidateResult } from './types.js';
import type { Toolset } from '../toolsets.js';
import type { LarkClientBundle } from '../auth.js';
import type { Logger } from 'pino';

export type { UnifiedSpec, ToolCtx } from './types.js';

function zodToUnified(t: FallbackSpec): UnifiedSpec {
  const inputSchema = zodToJsonSchema(t.schema, { target: 'openApi3' }) as Record<string, unknown>;
  const validate = (args: unknown): ValidateResult => {
    const parsed = t.schema.safeParse(args ?? {});
    if (parsed.success) return { ok: true, data: parsed.data };
    const zerr = parsed.error as z.ZodError;
    return { ok: false, error: zerr.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  };
  return {
    name: t.name,
    toolset: t.toolset,
    description: t.description,
    inputSchema,
    validate,
    handler: (args, ctx) => t.handler(args as z.infer<typeof t.schema>, ctx),
    source: 'fallback',
  };
}

export function loadAllTools(bundle: LarkClientBundle, logger: Logger): UnifiedSpec[] {
  const fallback = getFallbackTools().map(zodToUnified);

  let shim: UnifiedSpec[] = [];
  try {
    shim = loadShimTools(bundle, logger);
    logger.info({ shimCount: shim.length }, 'openclaw-shim tools loaded');
  } catch (err) {
    const e = err as Error;
    logger.error(
      { err: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') },
      'openclaw-shim failed to load — falling back to zod-only tools',
    );
  }

  let oauth: UnifiedSpec[] = [];
  try {
    oauth = getOAuthTools();
    logger.info({ oauthCount: oauth.length }, 'oauth tools loaded');
  } catch (err) {
    const e = err as Error;
    logger.error(
      { err: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') },
      'oauth tools failed to load',
    );
  }

  // Fallback tools win on name collision (shim is additive for new capabilities).
  // OAuth tools are appended last — their names (lark_oauth_*) should not collide.
  const names = new Set<string>();
  const merged: UnifiedSpec[] = [];
  for (const t of [...fallback, ...shim, ...oauth]) {
    if (names.has(t.name)) {
      logger.warn({ name: t.name, keep: 'first' }, 'duplicate tool name — keeping first');
      continue;
    }
    names.add(t.name);
    merged.push(t);
  }
  return merged;
}

export function filterByToolsets(
  tools: UnifiedSpec[],
  enabled: Set<Toolset>,
): Map<string, UnifiedSpec> {
  const out = new Map<string, UnifiedSpec>();
  for (const t of tools) {
    if (!enabled.has(t.toolset)) continue;
    out.set(t.name, t);
  }
  return out;
}
