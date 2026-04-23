# lark-hermes-mcp

**[English](./README.md) · [简体中文](./README.zh-CN.md)**

Thin **MCP stdio server** that exposes Feishu (飞书) / Lark capabilities as
function tools to Hermes, Claude Desktop, or any other MCP-compatible agent.

- **17 fallback tools** (hand-written) for messaging, bitable, calendar, docs, and task operations
- **36 tools bridged from [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark)** via a shim adapter
- **4 OAuth tools** (`lark_oauth_start` / `lark_oauth_complete` / `lark_oauth_status` / `lark_oauth_revoke`) driving OpenClaw's Device Flow for user-access-token authorization

> **Transport:** stdio (stdout is JSON-RPC only, pino logs go to stderr)
> **Auth:** tenant_access_token + user-access-token (OAuth Device Flow)
> **SDK:** `@larksuiteoapi/node-sdk` + `@larksuite/openclaw-lark`

## Requirements

- Node.js ≥ 22
- A Feishu or Lark **custom app** (自建应用) that you own
- An MCP-compatible client (e.g. Hermes, Claude Desktop, or any stdio MCP host)

## Installation

### Step 1 — Register your own Feishu / Lark app

This project does **not** ship with any pre-registered app credentials. Every
user must create their own app on the Feishu/Lark open platform.

1. Go to **https://open.feishu.cn/app** (国内 Feishu) or
   **https://open.larksuite.com/app** (海外 Lark).
2. Click **"创建企业自建应用" / "Create Custom App"**. Give it a name and icon.
3. After creation, open the app dashboard:
   - **凭证与基础信息 / Credentials & Basic Info** page → copy your
     `App ID` (format `cli_xxxxxxxxxxxxxxxx`) and `App Secret`.
   - **权限管理 / Permissions & Scopes** page → enable the scopes you plan to
     use. For the tools bundled here, the core set is:
     - `im:message`, `im:chat` (messaging)
     - `bitable:app` (多维表格)
     - `docx:document`, `drive:drive` (docs)
     - `calendar:calendar` (日历)
     - Task-related scopes if you want task tools
   - If you plan to use the OAuth (user-access-token) tools, also enable
     **Device Flow / OAuth** in your app settings. The OAuth tools request
     granular per-API scopes at runtime — `lark_oauth_start` will print the
     exact scope list on first call so you know what to enable.
4. **发布 / Publish** the app version in the app dashboard so your scopes take
   effect.

### Step 2 — Clone and install

```bash
git clone https://github.com/WilliamMo101/lark-hermes-mcp.git
cd lark-hermes-mcp
npm install     # triggers postinstall patches (see "Upstream & Patches" below)
npm run build
```

### Step 3 — Configure your credentials

**Standalone (any MCP host):**

```bash
cp .env.example .env
# then edit .env and paste the App ID / App Secret you got in Step 1
```

`.env` is git-ignored and will never be committed.

**Under Hermes:** you do not need a `.env` file. Put the variables directly in
`profiles/<your-agent>/config.yaml` under `mcp_servers.lark.env`:

```yaml
mcp_servers:
  lark:
    command: /path/to/node
    args:
      - /path/to/lark-hermes-mcp/dist/server.js
    env:
      LARK_APP_ID: "cli_xxxxxxxxxxxxxxxx"
      LARK_APP_SECRET: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      LARK_DOMAIN: "Feishu"
      LARK_ENABLED_TOOLSETS: "messaging,docs,bitable,calendar,other"
      LARK_LOG_LEVEL: "info"
    timeout: 120
    connect_timeout: 30
    tools:
      resources: false
      prompts: false
```

> **`LARK_DOMAIN`**: mainland Feishu → `Feishu`; overseas Lark → `Lark`. The
> wrong value will be rejected by the OAuth service (`invalid_client`).
>
> **`LARK_ENABLED_TOOLSETS`** must include `other` if you want the OAuth tools
> (`lark_oauth_*`) and task tools to be exposed.

### Step 4 — Run and verify

```bash
node dist/server.js     # starts the stdio MCP server
```

Or hook it up to your MCP host and invoke `feishu_get_user` or
`lark_oauth_status` as a smoke test.

Hermes exposes the tools as `mcp_lark_<name>` (underscores, per
`mcp_tool.py:sanitize_mcp_name_component`).

> Example paths in this README (such as `/root/.hermes/mcp-servers/…` in older
> snippets) reflect the author's own Hermes-on-WSL layout. Adapt them to
> wherever you check the repo out.

## Fallback tools (17)

These are hand-written specs in `src/adapter/fallback.ts`:

| toolset | name | what |
|---|---|---|
| messaging | `sendMessageFeishu` | send IM to chat / user / email |
| messaging | `sendCardFeishu` | send interactive card |
| messaging | `replyMessageFeishu` | reply to a message_id |
| messaging | `listMessagesFeishu` | list recent messages in a chat |
| bitable | `bitableListRecords` | paged record list with filter/sort |
| bitable | `bitableCreateRecord` | insert record |
| bitable | `bitableUpdateRecord` | update record |
| calendar | `calendarListCalendars` | list calendars |
| calendar | `calendarCreateEvent` | create event |
| calendar | `calendarListEvents` | list events in range |
| docs | `docxGetRawContent` | raw-text fetch of a docx |
| docs | `docxListBlocks` | block tree of a docx |
| other | `selfCheck` | diagnostics: credentials + token acquisition |
| other | `feishu_get_user` | get current user info |
| other | task-related helpers | (see `fallback.ts`) |

## OpenClaw-bridged tools (36)

`src/adapter/shim.ts` calls `registerXxxTools(api)` against
`@larksuite/openclaw-lark`'s internal registrations, wraps each tool with
typebox → JSON Schema flattening (for OpenAI function-calling compatibility),
and injects `withTicket` context via AsyncLocalStorage.

Tools appear with the `feishu_` / `mcp_doc_` prefix, e.g.
`feishu_bitable_app`, `feishu_calendar_event`, `feishu_im_chat_messages`.

## OAuth tools (4)

- `lark_oauth_start` — begin Device Flow (prints user_code + verification URL)
- `lark_oauth_complete` — poll for token after user authorizes in browser
- `lark_oauth_status` — check stored user token status (valid / needs_refresh / expired)
- `lark_oauth_revoke` — revoke stored user token

Tokens are encrypted (AES-256-GCM) and stored under
`~/.local/share/openclaw-feishu-uat/`.

## Smoke test (standalone, without an MCP host)

```bash
export LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_DOMAIN=Feishu
(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"selfCheck","arguments":{}}}'
) | node dist/server.js 2>/tmp/lark-mcp.err > /tmp/lark-mcp.out
jq '.result.tools | length' < /tmp/lark-mcp.out
jq 'select(.id==3)' < /tmp/lark-mcp.out
```

There is also a registration-count smoke test for the shim:

```bash
LARK_APP_ID=cli_xxx node scripts/shim-smoke.mjs
```

## Upstream & Patches

This project builds on top of
[`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark)
(MIT License) — 36 of the exposed tools are bridged directly from its native
tool registrations via `src/adapter/shim.ts`.

`scripts/postinstall-patches.mjs` runs automatically after `npm install` and
applies **idempotent** patches inside `node_modules/@larksuite/openclaw-lark/`
so that the package loads cleanly under Node 22 CJS:

1. Strip `import.meta.url` syntax from `version.js` (replaced with
   `createRequire`-based resolution).
2. Same treatment for `token-store.js`.
3. Build a minimal stub for `@openclaw/plugin-sdk` (only the pieces the
   registrations actually import).
4. Widen the package's `exports` map so deep `./src/*` imports resolve.

**These patches only modify files inside your local `node_modules/`.** The
upstream source is not modified, and the patches re-run safely on every
install.

## Troubleshooting

- **Nothing in the host's tool list** — grep the host's log for `MCP server 'lark'`. Common causes:
  - `LARK_APP_ID` / `LARK_APP_SECRET` not passed through — shell exports don't propagate if the host uses an allow-list env. Declare them in the MCP config block instead.
  - `dist/server.js` missing — run `npm run build`.
  - Wrong `node` binary — must be Node ≥ 22.
- **OAuth tools missing from tool list** — `LARK_ENABLED_TOOLSETS` must include `other`.
- **`invalid_scope` on `lark_oauth_start`** — one of the requested scopes isn't granted yet on your app. Open the app's Permissions page, enable the scopes listed in the error, publish a new version.
- **`invalid_client` on OAuth** — `LARK_DOMAIN` is wrong for your app region (国内 = `Feishu`, 海外 = `Lark`).
- **stdout pollution** (MCP client disconnects immediately) — some third-party lib wrote to stdout. Check stderr logs. `server.ts` already hijacks `console.*` and pino writes to stderr.
- **Rate limited client-side** — tune `LARK_THROTTLE_BITABLE_RPS` etc. via env.

## Project layout

```
src/
  server.ts                # MCP entry, console hijack, handlers
  auth.ts                  # @larksuiteoapi/node-sdk Client factory
  log.ts                   # pino → stderr
  toolsets.ts              # toolset enum + env filter
  util/throttle.ts         # per-toolset token bucket
  adapter/
    index.ts               # tool loader + toolset filter
    fallback.ts            # 17 hand-written fallback tool specs
    shim.ts                # OpenClaw bridge + schema flattening
    oauth-tools.ts         # 4 OAuth tools (Device Flow)
scripts/
  postinstall-patches.mjs  # idempotent node_modules patches
  shim-smoke.mjs           # registration-count smoke test
```

## Credits

- [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark) by OpenClaw — MIT License. This project wraps and depends on it.
- [Model Context Protocol](https://modelcontextprotocol.io/) SDK by Anthropic.
- Feishu / Lark Open Platform APIs.

## Disclaimer

This is a personal hobby project, provided as-is without any warranty. It is
not an official product of Feishu, Lark, ByteDance, or OpenClaw.

这是一个个人兴趣项目，按"现状"提供，不附带任何担保。本项目与飞书/Lark、
字节跳动、OpenClaw 官方团队无隶属关系，出现问题请通过 GitHub Issues 反馈。
