// OAuth tools for acquiring + managing user_access_token (UAT).
//
// Why this exists:
//   OpenClaw-native Feishu tools marked { as: 'user' } require a user OAuth
//   token stored via token-store.js. Without it, they return
//   need_user_authorization. This file adds MCP tools to drive the OAuth
//   Device Flow end-to-end so the MCP server can unlock those tools.
//
// Flow (two-step, stdio-friendly — no local HTTP callback needed):
//   1. lark_oauth_start(scope?)
//        → POST /oauth/v1/device_authorization
//        → returns { user_code, verification_uri, device_code, expires_in }
//        → LLM tells user: "Open <uri> and enter <user_code>"
//   2. lark_oauth_complete(device_code, poll_timeout_sec?)
//        → polls /open-apis/authen/v2/oauth/token
//        → on success: fetch /authen/v1/user_info, store token under appId:openId
//        → returns { status: 'ok', open_id, scope }
//
// Management tools:
//   - lark_oauth_status — does a stored token exist? is it still valid?
//   - lark_oauth_revoke — delete the stored token
//
// Identity model:
//   OpenClaw's tool-client.js auto-fills userOpenId with the app owner's
//   open_id when the ticket has no senderOpenId (our MCP stdio case always).
//   So as long as the token is stored under `<appId>:<ownerOpenId>`, future
//   user-token tool calls Just Work.

import { createRequire } from 'node:module';
import { z } from 'zod';
import { getLarkClient } from '../auth.js';
import type { UnifiedSpec, ValidateResult, ToolCtx } from './types.js';
import type { Toolset } from '../toolsets.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const require = createRequire(import.meta.url);

// Lazy-load OpenClaw core modules (CJS)
function getDeviceFlow() {
  return require(
    '@larksuite/openclaw-lark/src/core/device-flow.js',
  ) as {
    requestDeviceAuthorization: (p: {
      appId: string;
      appSecret: string;
      brand: string;
      scope?: string;
    }) => Promise<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresIn: number;
      interval: number;
    }>;
    pollDeviceToken: (p: {
      appId: string;
      appSecret: string;
      brand: string;
      deviceCode: string;
      expiresIn: number;
      interval: number;
      signal?: AbortSignal;
    }) => Promise<
      | {
          ok: true;
          token: {
            accessToken: string;
            refreshToken: string;
            expiresIn: number;
            refreshExpiresIn: number;
            scope: string;
          };
        }
      | { ok: false; error: string; message?: string }
    >;
    resolveOAuthEndpoints: (brand: string) => {
      deviceAuthorization: string;
      token: string;
    };
  };
}

// Real OpenClaw StoredToken shape (see uat-client.js where setStoredToken
// is called after a refresh). All timestamps are absolute epoch ms.
interface StoredToken {
  userOpenId: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  grantedAt: number;
}

function getTokenStore() {
  return require(
    '@larksuite/openclaw-lark/src/core/token-store.js',
  ) as {
    getStoredToken: (appId: string, userOpenId: string) => Promise<StoredToken | null>;
    setStoredToken: (token: StoredToken) => Promise<void>;
    removeStoredToken: (appId: string, userOpenId: string) => Promise<void>;
    tokenStatus: (token: StoredToken) => 'valid' | 'needs_refresh' | 'expired';
    maskToken: (token: string) => string;
  };
}

// Brand resolver — shim uses 'feishu' / 'lark' (lowercase); our bundle stores
// the human label.
function resolveBrand(domainLabel: string): string {
  return domainLabel.toLowerCase() === 'lark' ? 'lark' : 'feishu';
}

// Fetch user info (open_id) via UAT
async function fetchOpenId(accessToken: string, brand: string): Promise<string> {
  const host = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const res = await fetch(`${host}/open-apis/authen/v1/user_info`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: { open_id?: string };
  };
  if (!res.ok || data.code !== 0 || !data.data?.open_id) {
    throw new Error(
      `failed to fetch open_id via user_info: code=${data.code} msg=${data.msg ?? 'unknown'}`,
    );
  }
  return data.data.open_id;
}

// Load OpenClaw's TOOL_SCOPES source-of-truth — it's the authoritative mapping
// of tool-action -> required user scopes. We compute DEFAULT_SCOPES as the
// union of every scope referenced by the tools we expose (minus SENSITIVE_SCOPES
// like delete-calendar-event, which users must opt into explicitly via the
// `scope` arg).
function getToolScopes() {
  return require(
    '@larksuite/openclaw-lark/src/core/tool-scopes.js',
  ) as {
    TOOL_SCOPES: Record<string, string[]>;
    SENSITIVE_SCOPES: string[];
    filterSensitiveScopes: (scopes: string[]) => string[];
  };
}

function buildDefaultScopes(): string {
  const { TOOL_SCOPES, filterSensitiveScopes } = getToolScopes();
  const all = new Set<string>();
  for (const scopes of Object.values(TOOL_SCOPES)) {
    for (const s of scopes) all.add(s);
  }
  const safe = filterSensitiveScopes([...all]);
  // offline_access is required for refresh_token issuance, but not listed in
  // per-tool scopes because it's not enforced at the API level.
  safe.push('offline_access');
  return safe.sort().join(' ');
}

// Computed lazily so any patches/require errors surface only when the tool is
// actually invoked (not at module load).
let _defaultScopesCache: string | null = null;
function getDefaultScopes(): string {
  if (_defaultScopesCache === null) _defaultScopesCache = buildDefaultScopes();
  return _defaultScopesCache;
}

// ---------------------------------------------------------------------------
// Pending device_code -> flow params (in-memory, for a single MCP process)
// ---------------------------------------------------------------------------
interface PendingFlow {
  deviceCode: string;
  userCode: string;
  interval: number;
  expiresAt: number; // epoch ms
  scope: string;
}
const pendingFlows = new Map<string, PendingFlow>();

// ---------------------------------------------------------------------------
// Tool: lark_oauth_start
// ---------------------------------------------------------------------------

const startSchema = z.object({
  scope: z
    .string()
    .optional()
    .describe(
      `Space-separated OAuth scopes. If omitted, a broad default set covering messaging / bitable / calendar / drive / wiki / sheets / task is used.`,
    ),
});

const startTool: {
  spec: Omit<UnifiedSpec, 'validate' | 'inputSchema'> & {
    schema: typeof startSchema;
  };
} = {
  spec: {
    name: 'lark_oauth_start',
    toolset: 'other',
    description:
      '【OAuth】启动飞书用户授权的 Device Flow,返回授权 URL 和用户码。使用后请让用户在浏览器打开 verification_uri 并输入 user_code,然后调用 lark_oauth_complete(device_code) 完成授权。授权成功后,所有 feishu_* 用户态工具(建多维表、改日历、创文档等)即可使用。',
    schema: startSchema,
    source: 'fallback',
    async handler(args, { logger }): Promise<unknown> {
      const a = args as z.infer<typeof startSchema>;
      const bundle = getLarkClient();
      const brand = resolveBrand(bundle.domain);
      const scope = a.scope?.trim() || getDefaultScopes();

      const { requestDeviceAuthorization } = getDeviceFlow();
      const res = await requestDeviceAuthorization({
        appId: bundle.appId,
        appSecret: bundle.appSecret,
        brand,
        scope,
      });

      pendingFlows.set(res.deviceCode, {
        deviceCode: res.deviceCode,
        userCode: res.userCode,
        interval: res.interval,
        expiresAt: Date.now() + res.expiresIn * 1000,
        scope,
      });

      logger.info(
        {
          verificationUri: res.verificationUri,
          expiresInSec: res.expiresIn,
          scopeCount: scope.split(/\s+/).length,
        },
        'device flow initiated',
      );

      return {
        status: 'awaiting_user',
        user_code: res.userCode,
        verification_uri: res.verificationUri,
        verification_uri_complete: res.verificationUriComplete,
        device_code: res.deviceCode,
        expires_in_seconds: res.expiresIn,
        poll_interval_seconds: res.interval,
        scope_requested: scope,
        next_step: `Please visit ${res.verificationUri} in a browser, enter the code "${res.userCode}" (or open ${res.verificationUriComplete} directly), approve the listed scopes, then call lark_oauth_complete with device_code=${res.deviceCode}.`,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Tool: lark_oauth_complete
// ---------------------------------------------------------------------------

const completeSchema = z.object({
  device_code: z.string().min(10),
  poll_timeout_sec: z
    .number()
    .int()
    .min(5)
    .max(90)
    .optional()
    .default(60)
    .describe(
      'Max seconds to block waiting for the user to authorize. If still pending at timeout, returns status=pending — call again to keep polling. Max 90 (MCP call timeout).',
    ),
});

const completeTool: {
  spec: Omit<UnifiedSpec, 'validate' | 'inputSchema'> & {
    schema: typeof completeSchema;
  };
} = {
  spec: {
    name: 'lark_oauth_complete',
    toolset: 'other',
    description:
      '【OAuth】轮询 Device Flow 的 token 端点,直到用户在浏览器完成授权或超时。成功后自动持久化 user_access_token 并返回 open_id。device_code 来自 lark_oauth_start 的返回值。',
    schema: completeSchema,
    source: 'fallback',
    async handler(args, { logger }): Promise<unknown> {
      const a = args as z.infer<typeof completeSchema>;
      const flow = pendingFlows.get(a.device_code);
      if (!flow) {
        throw new Error(
          `Unknown device_code. Either it expired, the server restarted, or lark_oauth_start was never called for this code. Start a new flow with lark_oauth_start.`,
        );
      }
      if (Date.now() > flow.expiresAt) {
        pendingFlows.delete(a.device_code);
        throw new Error(
          `device_code expired (device flow codes live for ~4min). Run lark_oauth_start again.`,
        );
      }

      const bundle = getLarkClient();
      const brand = resolveBrand(bundle.domain);
      const { pollDeviceToken } = getDeviceFlow();

      // Bound the single-call wait so MCP doesn't hit its 120s timeout.
      const pollMs = a.poll_timeout_sec * 1000;
      const deadline = Date.now() + pollMs;
      const effExpiresIn = Math.max(
        1,
        Math.min(
          Math.floor((flow.expiresAt - Date.now()) / 1000),
          Math.floor(pollMs / 1000),
        ),
      );
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), pollMs);

      try {
        const res = await pollDeviceToken({
          appId: bundle.appId,
          appSecret: bundle.appSecret,
          brand,
          deviceCode: flow.deviceCode,
          expiresIn: effExpiresIn,
          interval: flow.interval,
          signal: controller.signal,
        });

        if (!res.ok) {
          if (res.error === 'expired_token' && Date.now() < flow.expiresAt) {
            // Our internal poll budget ran out, not the actual device_code.
            return {
              status: 'pending',
              message:
                'Still waiting for user authorization. Call lark_oauth_complete again with the same device_code to keep polling.',
              device_code: a.device_code,
              seconds_until_device_code_expires: Math.max(
                0,
                Math.round((flow.expiresAt - Date.now()) / 1000),
              ),
            };
          }
          pendingFlows.delete(a.device_code);
          throw new Error(
            `OAuth failed: ${res.error}${res.message ? ` — ${res.message}` : ''}`,
          );
        }

        // Success. Fetch open_id and persist.
        const { setStoredToken } = getTokenStore();
        const openId = await fetchOpenId(res.token.accessToken, brand);
        const now = Date.now();
        const stored: StoredToken = {
          userOpenId: openId,
          appId: bundle.appId,
          accessToken: res.token.accessToken,
          refreshToken: res.token.refreshToken,
          expiresAt: now + res.token.expiresIn * 1000,
          refreshExpiresAt: now + res.token.refreshExpiresIn * 1000,
          scope: res.token.scope,
          grantedAt: now,
        };
        await setStoredToken(stored);
        pendingFlows.delete(a.device_code);

        logger.info(
          {
            openIdRedacted: `${openId.slice(0, 6)}…${openId.slice(-3)}`,
            scope: res.token.scope,
            expiresInSec: res.token.expiresIn,
          },
          'user token stored',
        );

        return {
          status: 'ok',
          open_id: openId,
          scope_granted: res.token.scope,
          access_token_expires_in_sec: res.token.expiresIn,
          refresh_token_expires_in_sec: res.token.refreshExpiresIn,
          message: `Authorization complete. User-token tools (feishu_bitable_app, feishu_calendar_event, etc.) are now available.`,
        };
      } finally {
        clearTimeout(abortTimer);
        void deadline;
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Tool: lark_oauth_status
// ---------------------------------------------------------------------------

const statusSchema = z.object({
  open_id: z
    .string()
    .optional()
    .describe(
      `Optional. If omitted, checks the app owner's stored token (the default identity used by feishu_* user tools).`,
    ),
});

const statusTool: {
  spec: Omit<UnifiedSpec, 'validate' | 'inputSchema'> & {
    schema: typeof statusSchema;
  };
} = {
  spec: {
    name: 'lark_oauth_status',
    toolset: 'other',
    description:
      '【OAuth】查询某个 Feishu 用户(默认为 app 所有者)是否已有可用的 user_access_token。返回 has_token / access_expired / refresh_expired / expires_in_sec。',
    schema: statusSchema,
    source: 'fallback',
    async handler(args): Promise<unknown> {
      const a = args as z.infer<typeof statusSchema>;
      const bundle = getLarkClient();
      const openId = a.open_id?.trim();
      if (!openId) {
        return {
          status: 'unknown',
          message:
            'open_id omitted. Tip: call any user-token tool once; OpenClaw auto-discovers the app owner open_id (visible in stderr log). Then call lark_oauth_status({ open_id: "ou_..." }).',
        };
      }
      const { getStoredToken, tokenStatus } = getTokenStore();
      const stored = await getStoredToken(bundle.appId, openId);
      if (!stored) {
        return { status: 'missing', has_token: false, open_id: openId };
      }
      const freshness = tokenStatus(stored);
      return {
        status: freshness === 'expired' ? 'expired' : 'ok',
        has_token: true,
        freshness,
        open_id: openId,
        access_token_expires_at_ms: stored.expiresAt,
        refresh_token_expires_at_ms: stored.refreshExpiresAt,
        access_token_expires_in_sec: Math.max(
          0,
          Math.round((stored.expiresAt - Date.now()) / 1000),
        ),
        scope: stored.scope,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Tool: lark_oauth_revoke
// ---------------------------------------------------------------------------

const revokeSchema = z.object({
  open_id: z.string().min(1),
  confirm: z
    .boolean()
    .describe('Must be true. Prevents accidental revocation from hallucinated args.'),
});

const revokeTool: {
  spec: Omit<UnifiedSpec, 'validate' | 'inputSchema'> & {
    schema: typeof revokeSchema;
  };
} = {
  spec: {
    name: 'lark_oauth_revoke',
    toolset: 'other',
    description:
      '【OAuth】删除指定用户的已存储 user_access_token。调用者必须传 confirm=true。之后该用户的 feishu_* 工具会再次要求授权。',
    schema: revokeSchema,
    source: 'fallback',
    async handler(args): Promise<unknown> {
      const a = args as z.infer<typeof revokeSchema>;
      if (!a.confirm) {
        throw new Error('confirm must be true.');
      }
      const bundle = getLarkClient();
      const { removeStoredToken } = getTokenStore();
      await removeStoredToken(bundle.appId, a.open_id);
      return { status: 'revoked', open_id: a.open_id };
    },
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function wrap<S extends z.ZodTypeAny>(t: {
  spec: Omit<UnifiedSpec, 'validate' | 'inputSchema'> & { schema: S };
}): UnifiedSpec {
  const s = t.spec;
  return {
    name: s.name,
    toolset: s.toolset as Toolset,
    description: s.description,
    inputSchema: zodToJsonSchema(s.schema, { target: 'openApi3' }) as Record<string, unknown>,
    validate: (args: unknown): ValidateResult => {
      const parsed = s.schema.safeParse(args ?? {});
      if (parsed.success) return { ok: true, data: parsed.data };
      const ze = parsed.error as z.ZodError;
      return {
        ok: false,
        error: ze.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    },
    handler: (args: unknown, ctx: ToolCtx) => s.handler(args, ctx),
    source: 'fallback',
  };
}

export function getOAuthTools(): UnifiedSpec[] {
  return [wrap(startTool), wrap(completeTool), wrap(statusTool), wrap(revokeTool)];
}
