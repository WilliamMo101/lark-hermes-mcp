// OpenClaw-lark shim loader.
//
// Loads the 36 native Feishu tools from @larksuite/openclaw-lark by calling its
// registerXxxTools(api) hooks with a minimal api surface, captures the
// { name, description, parameters, execute } of each, and wraps them in
// UnifiedSpec for the MCP server.
//
// Schema: OpenClaw tools use @sinclair/typebox, which IS JSON Schema — we emit
// the typebox object directly as inputSchema and use Value.Check / Value.Errors
// for runtime validation.
//
// Execution: OpenClaw's ToolClient reads request context from
// AsyncLocalStorage via getTicket(). We wrap each invocation in
// withTicket(...) so downstream code (account resolution, sender identity,
// etc.) has the expected context.

import { createRequire } from 'node:module';
import { Value } from '@sinclair/typebox/value';
import type { LarkClientBundle } from '../auth.js';
import type { Logger } from 'pino';
import type { Toolset } from '../toolsets.js';
import type { UnifiedSpec, ValidateResult } from './types.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types we care about from OpenClaw (structural — not imported)
// ---------------------------------------------------------------------------

interface NativeTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown; // typebox schema (TSchema)
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

interface LarkTicket {
  messageId: string;
  chatId: string;
  accountId: string;
  startTime: number;
  senderOpenId?: string;
  chatType?: 'p2p' | 'group';
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Lazy-load OpenClaw modules (CJS)
// ---------------------------------------------------------------------------

function loadOpenclaw() {
  const { withTicket } = require(
    '@larksuite/openclaw-lark/src/core/lark-ticket.js',
  ) as { withTicket: <T>(t: LarkTicket, fn: () => T | Promise<T>) => T | Promise<T> };

  const { registerOapiTools } = require(
    '@larksuite/openclaw-lark/src/tools/oapi/index.js',
  ) as { registerOapiTools: (api: unknown) => void };

  const { registerFeishuMcpDocTools } = require(
    '@larksuite/openclaw-lark/src/tools/mcp/doc/index.js',
  ) as { registerFeishuMcpDocTools: (api: unknown) => void };

  const { registerFeishuOAuthTool } = require(
    '@larksuite/openclaw-lark/src/tools/oauth.js',
  ) as { registerFeishuOAuthTool: (api: unknown) => void };

  const { registerFeishuOAuthBatchAuthTool } = require(
    '@larksuite/openclaw-lark/src/tools/oauth-batch-auth.js',
  ) as { registerFeishuOAuthBatchAuthTool: (api: unknown) => void };

  return {
    withTicket,
    registerOapiTools,
    registerFeishuMcpDocTools,
    registerFeishuOAuthTool,
    registerFeishuOAuthBatchAuthTool,
  };
}

// ---------------------------------------------------------------------------
// Toolset classification
// ---------------------------------------------------------------------------

function classifyToolset(name: string): Toolset {
  // Order matters — more specific prefixes first.
  if (name.includes('_bitable')) return 'bitable';
  if (name.includes('_calendar')) return 'calendar';
  if (
    name.includes('_wiki') ||
    name.includes('_drive') ||
    name.includes('_sheet') ||
    name === 'feishu_search_doc_wiki' ||
    name === 'feishu_fetch_doc' ||
    name === 'feishu_create_doc' ||
    name === 'feishu_update_doc' ||
    name === 'feishu_doc_comments' ||
    name === 'feishu_doc_media'
  ) {
    return 'docs';
  }
  if (
    name.includes('_chat') ||
    name.includes('_im_') ||
    name === 'feishu_get_user' ||
    name === 'feishu_search_user'
  ) {
    return 'messaging';
  }
  // task + oauth + everything else
  return 'other';
}

// ---------------------------------------------------------------------------
// typebox → JSON Schema (cleanup pass)
// ---------------------------------------------------------------------------

/**
 * Typebox schemas are already JSON Schema — but they carry runtime helper
 * fields like `[Symbol]` and `$static` that JSON.stringify might choke on.
 * A shallow round-trip strips symbols and non-JSON-safe fields cleanly.
 *
 * ALSO: OpenAI's function-calling validator has a TIGHT constraint on the
 * top level of a tool's `parameters` schema:
 *   - MUST have `type: "object"`
 *   - MUST NOT have `oneOf` / `anyOf` / `allOf` / `enum` / `not`
 *
 * Many OpenClaw tools use `Type.Union([variantA, variantB, ...])` to express
 * action-discriminated payloads, which emits `{ anyOf: [...] }` with no
 * top-level `type`. OpenAI rejects both conditions. We flatten the union
 * into a single permissive object schema:
 *   - union properties = merge of all variants' properties
 *   - required = intersection of all variants' required fields (fields that
 *     MUST appear in every variant stay required; anything variant-specific
 *     becomes optional at OpenAI's view)
 *   - `action` (or the sole const-discriminator field) collapses to an
 *     enum across all variants, preserved inside `properties`
 *   - additionalProperties: true
 *
 * Runtime validation still uses the ORIGINAL typebox schema via
 * `Value.Check`, so per-variant requiredness is enforced strictly when the
 * agent actually calls the tool. The flattened schema is only for OpenAI's
 * pre-send lint.
 */

interface JsonSchemaLike {
  type?: string | string[];
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  additionalProperties?: boolean | Record<string, unknown>;
  [k: string]: unknown;
}

function mergeVariantSchemas(variants: JsonSchemaLike[]): Record<string, unknown> {
  const mergedProps: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  const objectVariants = variants.filter(
    (v) => v && typeof v === 'object' && v.type === 'object',
  );
  // Fallback: if nothing is an object variant, just return a permissive object.
  if (objectVariants.length === 0) {
    return { type: 'object', additionalProperties: true };
  }

  for (const v of objectVariants) {
    const props = (v.properties ?? {}) as Record<string, JsonSchemaLike>;
    for (const [name, propSchema] of Object.entries(props)) {
      if (!(name in mergedProps)) {
        mergedProps[name] = propSchema;
        continue;
      }
      const existing = mergedProps[name] as JsonSchemaLike;
      // Discriminator pattern: two `const` variants for the same key → collapse
      // into an enum so the agent still sees the full action list.
      const a = existing as JsonSchemaLike;
      const b = propSchema as JsonSchemaLike;
      const aConst = typeof a === 'object' && a && 'const' in a ? a.const : undefined;
      const bConst = typeof b === 'object' && b && 'const' in b ? b.const : undefined;
      if (aConst !== undefined && bConst !== undefined) {
        // Collect existing enum / const + new const
        const existingEnum = (a as { enum?: unknown[] }).enum;
        const values: unknown[] = existingEnum ? [...existingEnum] : [aConst];
        if (!values.includes(bConst)) values.push(bConst);
        const merged: Record<string, unknown> = {
          type: a.type ?? b.type ?? 'string',
          enum: values,
        };
        if (a.description) merged.description = a.description;
        else if (b.description) merged.description = b.description;
        mergedProps[name] = merged;
      } else if (
        (a as { enum?: unknown[] }).enum &&
        bConst !== undefined
      ) {
        // existing has enum, new variant has const → append
        const enumVals = [...(a as { enum: unknown[] }).enum];
        if (!enumVals.includes(bConst)) enumVals.push(bConst);
        mergedProps[name] = { ...a, enum: enumVals };
      }
      // else: keep the first definition (both variants share the same prop shape)
    }
    const req = (v.required ?? []) as string[];
    for (const r of req) {
      requiredCounts.set(r, (requiredCounts.get(r) ?? 0) + 1);
    }
  }

  // Required = fields present in EVERY variant's required list.
  const required: string[] = [];
  for (const [name, count] of requiredCounts) {
    if (count === objectVariants.length) required.push(name);
  }

  return {
    type: 'object',
    properties: mergedProps,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

function toCleanJsonSchema(schema: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(schema, (_key, value) => {
    if (typeof value === 'function') return undefined;
    return value;
  });
  const obj = JSON.parse(serialized) as JsonSchemaLike | null;
  if (!obj || typeof obj !== 'object') {
    return { type: 'object', additionalProperties: true };
  }

  // Flatten top-level anyOf/oneOf (OpenAI rejects these at the root).
  const union = obj.anyOf ?? obj.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const merged = mergeVariantSchemas(union);
    // Preserve description from the outer schema if present.
    if (obj.description && !(merged as JsonSchemaLike).description) {
      (merged as JsonSchemaLike).description = obj.description;
    }
    return merged;
  }

  // Top-level allOf / enum / not are also banned — degrade to permissive.
  if (obj.allOf || obj.enum || obj.not) {
    const desc = obj.description;
    return {
      type: 'object',
      additionalProperties: true,
      ...(desc ? { description: desc } : {}),
    };
  }

  if (obj.type === undefined) {
    obj.type = 'object';
  }
  return obj as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation via typebox
// ---------------------------------------------------------------------------

function makeValidator(schema: unknown): (args: unknown) => ValidateResult {
  return (args: unknown) => {
    const s = schema as Parameters<typeof Value.Check>[0];
    if (Value.Check(s, args)) {
      return { ok: true, data: args };
    }
    const errors = [...Value.Errors(s, args)].slice(0, 5).map((e) => {
      const path = e.path || '(root)';
      return `${path}: ${e.message}`;
    });
    return { ok: false, error: errors.join('; ') };
  };
}

// ---------------------------------------------------------------------------
// Ticket wrapper
// ---------------------------------------------------------------------------

function makeTicket(): LarkTicket {
  return {
    messageId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'mcp:stdio',
    accountId: 'default',
    startTime: Date.now(),
    chatType: 'p2p',
    // senderOpenId intentionally undefined — user-token tools will throw
    // UserAuthRequiredError which we translate to a clean MCP error.
  };
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

// OpenClaw tools return one of:
//   - { content: [{ type: 'text', text: '...' }], details: data }   (via formatToolResult / json)
//   - { content: [{ type: 'text', text: '...' }], isError: true }   (error)
//
// For MCP, we want the inner `details` (if present) or the full content text.
// Returning `details` gives the LLM clean structured data. If `details` is
// absent, we return the content array as-is.

type OpenclawResult =
  | {
      content?: { type: string; text: string }[];
      details?: unknown;
      isError?: boolean;
    }
  | string
  | unknown;

// Error markers inside OpenClaw's formatToolError `details` that we
// promote back to thrown exceptions so server.ts can format them uniformly.
const USER_AUTH_ERRORS = new Set([
  'need_user_authorization',
  'user_auth_required',
  'user_scope_insufficient',
]);

function normalizeResult(raw: OpenclawResult): unknown {
  if (raw && typeof raw === 'object') {
    const r = raw as { details?: unknown; content?: unknown; isError?: boolean };

    // OpenClaw wraps errors as { content, details: { error: "…", …ctx } }.
    // Detect common auth-required markers and re-throw so friendlyError runs.
    if (r.details && typeof r.details === 'object') {
      const d = r.details as { error?: unknown };
      if (typeof d.error === 'string' && USER_AUTH_ERRORS.has(d.error)) {
        const e = new Error(d.error) as Error & { name: string; details?: unknown };
        e.name = 'UserAuthRequiredError';
        e.details = d;
        throw e;
      }
    }

    if ('details' in r && r.details !== undefined) {
      return r.details;
    }
    if (r.content !== undefined) {
      return { content: r.content, isError: r.isError };
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

interface StructuredError {
  error: string;
  code: string | number;
  hint?: string;
  details?: unknown;
}

function friendlyError(err: unknown): StructuredError {
  const e = err as {
    name?: string;
    message?: string;
    code?: string | number;
    apiName?: string;
    scopes?: string[];
    appId?: string;
  };

  const name = e?.name ?? '';
  const msg = e?.message ?? String(err);

  if (name === 'UserAuthRequiredError') {
    return {
      error: msg,
      code: 'USER_AUTH_REQUIRED',
      hint:
        'This Feishu tool requires user OAuth authorization. Run the OAuth Device Flow: ' +
        '(1) call lark_oauth_start to get a verification_uri + user_code, ' +
        '(2) open the URL in a browser and approve the listed scopes, ' +
        '(3) call lark_oauth_complete with the returned device_code to persist the user_access_token. ' +
        'Then retry the original tool. If you already authorized, it is possible the token is stored under a different open_id than the app-owner fallback — call lark_oauth_status({ open_id }) to verify.',
      details: {
        apiName: e?.apiName,
        requiredScopes: e?.scopes,
      },
    };
  }

  if (name === 'AppScopeMissingError' || String(e?.code) === '99991672') {
    return {
      error: msg,
      code: 'APP_SCOPE_MISSING',
      hint:
        'The Feishu app is missing required API scopes. Open the Feishu OpenPlatform admin console, ' +
        'navigate to the app settings → Permissions, and add the scopes listed in details.requiredScopes.',
      details: { apiName: e?.apiName, requiredScopes: e?.scopes, appId: e?.appId },
    };
  }

  return {
    error: msg,
    code: e?.code ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadShimTools(bundle: LarkClientBundle, logger: Logger): UnifiedSpec[] {
  const openclaw = loadOpenclaw();

  const natives: NativeTool[] = [];
  const shimLog = logger.child({ src: 'openclaw' });

  const api = {
    config: {
      channels: {
        feishu: {
          appId: bundle.appId,
          appSecret: bundle.appSecret,
          domain: bundle.domain.toLowerCase() === 'lark' ? 'lark' : 'feishu',
          tools: {
            doc: true,
            wiki: true,
            drive: true,
            sheets: true,
            mail: true,
            perm: false,
            okr: false,
            scopes: true,
          },
        },
      },
    },
    logger: {
      debug: (...a: unknown[]) => shimLog.debug(a.map(String).join(' ')),
      info: (...a: unknown[]) => shimLog.info(a.map(String).join(' ')),
      warn: (...a: unknown[]) => shimLog.warn(a.map(String).join(' ')),
      error: (...a: unknown[]) => shimLog.error(a.map(String).join(' ')),
    },
    registerTool: (t: NativeTool) => {
      natives.push(t);
    },
    registerCommand: () => {},
    registerInteractiveHandler: () => {},
    registerChannel: () => {},
  };

  openclaw.registerOapiTools(api);
  openclaw.registerFeishuMcpDocTools(api);
  openclaw.registerFeishuOAuthTool(api);
  openclaw.registerFeishuOAuthBatchAuthTool(api);

  return natives.map((t): UnifiedSpec => ({
    name: t.name,
    toolset: classifyToolset(t.name),
    description: t.description,
    inputSchema: toCleanJsonSchema(t.parameters),
    validate: makeValidator(t.parameters),
    source: 'openclaw-shim',
    async handler(args, _ctx) {
      const ticket = makeTicket();
      const toolCallId = `tc-${ticket.messageId}`;
      try {
        const raw = await openclaw.withTicket(ticket, () => t.execute(toolCallId, args));
        return normalizeResult(raw);
      } catch (err) {
        const structured = friendlyError(err);
        // Re-throw a plain Error so server.ts's existing catch builds an
        // isError tool result uniformly.
        const rethrown = new Error(structured.error) as Error & {
          code?: string | number;
          details?: unknown;
          hint?: string;
        };
        rethrown.code = structured.code;
        rethrown.details = structured.details;
        rethrown.hint = structured.hint;
        throw rethrown;
      }
    },
  }));
}
