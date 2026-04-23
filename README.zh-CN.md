# lark-hermes-mcp

**[English](./README.md) · [简体中文](./README.zh-CN.md)**

当你从Openclaw转到Hermes上是否发现他跟你的飞书Bot仅具备沟通功能，原来适配opencalw可以操作多维表格的插件
用不了？恭喜你找到了解决方案。
一个轻量的 **MCP stdio 服务器**，把飞书（Feishu）/ Lark 的开放平台能力
暴露成 function tool，供 Hermes、Claude Desktop 或其他兼容 MCP 的 Agent 调用。

- **17 个手写 fallback 工具**，覆盖消息、多维表格、日历、文档、任务
- **36 个桥接工具**，通过 shim 适配器从
  [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark) 原生注册中导入
- **4 个 OAuth 工具**（`lark_oauth_start` / `lark_oauth_complete` / `lark_oauth_status` / `lark_oauth_revoke`），
  驱动 OpenClaw 的 Device Flow 完成用户态授权（user-access-token）

> **传输协议：** stdio（stdout 只发 JSON-RPC，pino 日志走 stderr）
> **鉴权：** tenant_access_token + user-access-token（OAuth 设备流）
> **SDK：** `@larksuiteoapi/node-sdk` + `@larksuite/openclaw-lark`

## 运行环境要求

- Node.js ≥ 22
- 一个**你自己**的飞书或 Lark **自建应用**
- 一个支持 MCP 的客户端（例如 Hermes、Claude Desktop，或任意 stdio MCP 宿主）

## 安装

### Step 1 — 注册你自己的飞书 / Lark 应用

本项目**不自带**任何预注册的应用凭据。每个使用者都需要自己去飞书/Lark
开放平台创建一个自建应用。

1. 打开 **https://open.feishu.cn/app**（国内飞书）
   或 **https://open.larksuite.com/app**（海外 Lark）。
2. 点击 **"创建企业自建应用"**，填写名称和图标。
3. 创建完成后进入应用管理页：
   - **凭证与基础信息** 页 → 复制 `App ID`（格式 `cli_xxxxxxxxxxxxxxxx`）
     和 `App Secret`。
   - **权限管理** 页 → 按你要用的工具开启对应权限。这里自带的工具最少需要：
     - `im:message`、`im:chat`（消息）
     - `bitable:app`（多维表格）
     - `docx:document`、`drive:drive`（文档）
     - `calendar:calendar`（日历）
     - 任务相关的 scope（如果要用任务工具）
   - 如果要用 OAuth（用户态 access_token）的工具，还要在应用设置里启用
     **Device Flow / OAuth**。OAuth 工具在运行时会按需申请更细粒度的 scope
     ——首次调用 `lark_oauth_start` 时会打印具体要开哪些 scope。
4. 在应用控制台里**发布**应用版本，让权限生效。

### Step 2 — 克隆仓库并安装

```bash
git clone https://github.com/WilliamMo101/lark-hermes-mcp.git
cd lark-hermes-mcp
npm install     # 会自动触发 postinstall patches，详见 "Upstream & Patches"
npm run build
```

### Step 3 — 配置你的凭据

**独立运行（任意 MCP 宿主）：**

```bash
cp .env.example .env
# 然后编辑 .env，把 Step 1 里拿到的 App ID / App Secret 粘贴进去
```

`.env` 已经在 `.gitignore` 里，不会被提交到 git。

**在 Hermes 里跑：** 不需要 `.env` 文件，直接在
`profiles/<你的 agent>/config.yaml` 的 `mcp_servers.lark.env` 下写：

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

> **`LARK_DOMAIN`**：国内飞书填 `Feishu`，海外 Lark 填 `Lark`。填错会被
> OAuth 服务拒绝（`invalid_client`）。
>
> **`LARK_ENABLED_TOOLSETS`** 必须包含 `other`，否则 OAuth 工具
> （`lark_oauth_*`）和任务工具不会被暴露出来。

### Step 4 — 运行并验证

```bash
node dist/server.js     # 启动 stdio MCP 服务器
```

或者接到你的 MCP 宿主里，调用 `feishu_get_user` 或 `lark_oauth_status`
做一次冒烟测试。

Hermes 会把这些工具暴露成 `mcp_lark_<name>` 的形式（下划线，由
`mcp_tool.py:sanitize_mcp_name_component` 规范化）。

> README 里如果出现 `/root/.hermes/mcp-servers/…` 这类绝对路径，是作者自己
> Hermes on WSL 的布局，请按你自己的目录结构调整。

## Fallback 工具（17 个）

这些是写死在 `src/adapter/fallback.ts` 里的工具规格：

| 工具集 | 名称 | 作用 |
|---|---|---|
| messaging | `sendMessageFeishu` | 给 chat / user / email 发 IM |
| messaging | `sendCardFeishu` | 发交互卡片 |
| messaging | `replyMessageFeishu` | 回复某条 message_id |
| messaging | `listMessagesFeishu` | 列出某群最近消息 |
| bitable | `bitableListRecords` | 分页列记录（支持 filter/sort）|
| bitable | `bitableCreateRecord` | 新建记录 |
| bitable | `bitableUpdateRecord` | 更新记录 |
| calendar | `calendarListCalendars` | 列出日历 |
| calendar | `calendarCreateEvent` | 创建日程 |
| calendar | `calendarListEvents` | 区间内列日程 |
| docs | `docxGetRawContent` | 抓取 docx 的纯文本 |
| docs | `docxListBlocks` | 抓取 docx 的 block 树 |
| other | `selfCheck` | 诊断：凭据和 token 获取 |
| other | `feishu_get_user` | 获取当前用户信息 |
| other | 任务相关工具 | 详见 `fallback.ts` |

## OpenClaw 桥接的工具（36 个）

`src/adapter/shim.ts` 把 `@larksuite/openclaw-lark` 里的
`registerXxxTools(api)` 原生注册拿过来，对每个工具做 typebox → JSON Schema
扁平化（兼容 OpenAI function-calling 的 schema 限制），并通过
AsyncLocalStorage 注入 `withTicket` 上下文。

这些工具会带 `feishu_` / `mcp_doc_` 前缀，例如
`feishu_bitable_app`、`feishu_calendar_event`、`feishu_im_chat_messages`。

## OAuth 工具（4 个）

- `lark_oauth_start` — 启动 Device Flow（打印 user_code + verification URL）
- `lark_oauth_complete` — 用户在浏览器完成授权后，轮询拿 token
- `lark_oauth_status` — 查询本地存的用户 token 状态（valid / needs_refresh / expired）
- `lark_oauth_revoke` — 撤销本地存的用户 token

Token 经 AES-256-GCM 加密存在
`~/.local/share/openclaw-feishu-uat/` 下。

## 冒烟测试（脱离 MCP 宿主）

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

也可以跑一个 shim 注册计数的冒烟测试：

```bash
LARK_APP_ID=cli_xxx node scripts/shim-smoke.mjs
```

## 上游依赖与补丁（Upstream & Patches）

本项目构建在
[`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark)（MIT 许可）
之上——其中 36 个工具是通过 `src/adapter/shim.ts` 从它的原生注册桥接过来的。

`scripts/postinstall-patches.mjs` 会在 `npm install` 之后自动运行，在
`node_modules/@larksuite/openclaw-lark/` 内部打**幂等**补丁，让这个包在
Node 22 CJS 下能加载：

1. 把 `version.js` 里的 `import.meta.url` 语法去掉（换成基于 `createRequire` 的实现）。
2. 对 `token-store.js` 做同样处理。
3. 生成一个最小的 `@openclaw/plugin-sdk` stub（只包含原生注册真正 import 到的部分）。
4. 把这个包的 `exports` 映射放宽，允许深层 `./src/*` 导入。

**这些补丁只修改你本地 `node_modules/` 里的文件。** 上游源代码不会被改动，
补丁每次安装都能安全地重新执行。

## 常见问题

- **宿主的 tool list 里什么都没有** — grep 宿主日志找 `MCP server 'lark'`。常见原因：
  - `LARK_APP_ID` / `LARK_APP_SECRET` 没传进来——如果宿主用了 env 白名单，shell 里 export 的变量不会透传，必须写在 MCP 配置块里。
  - `dist/server.js` 不存在——跑一下 `npm run build`。
  - 用错了 `node` 版本——必须 Node ≥ 22。
- **OAuth 工具不在 tool list 里** — `LARK_ENABLED_TOOLSETS` 必须包含 `other`。
- **`lark_oauth_start` 报 `invalid_scope`** — 请求的某个 scope 在应用里还没开通。去应用的"权限管理"页开通报错里列出的 scope，重新发布版本。
- **OAuth 报 `invalid_client`** — `LARK_DOMAIN` 和你应用所在区域对不上（国内 = `Feishu`，海外 = `Lark`）。
- **stdout 被污染**（MCP 客户端连上就断开）— 某个第三方库往 stdout 写了东西。去看 stderr 日志。`server.ts` 已经劫持了 `console.*`，pino 也是写 stderr 的。
- **客户端侧限流** — 通过 env 调 `LARK_THROTTLE_BITABLE_RPS` 等变量。

## 项目结构

```
src/
  server.ts                # MCP 入口，console 劫持，handler
  auth.ts                  # @larksuiteoapi/node-sdk Client 工厂
  log.ts                   # pino → stderr
  toolsets.ts              # 工具集枚举 + 环境变量过滤
  util/throttle.ts         # 每工具集的 token bucket
  adapter/
    index.ts               # 工具加载器 + 工具集过滤
    fallback.ts            # 17 个手写 fallback 工具规格
    shim.ts                # OpenClaw 桥接 + schema 扁平化
    oauth-tools.ts         # 4 个 OAuth 工具（Device Flow）
scripts/
  postinstall-patches.mjs  # node_modules 幂等补丁
  shim-smoke.mjs           # 注册计数冒烟测试
```

## 鸣谢

- [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark)（作者 OpenClaw，MIT 许可）——本项目在它之上做封装和桥接。
- [Model Context Protocol](https://modelcontextprotocol.io/)（Anthropic）SDK。
- 飞书 / Lark 开放平台 API。

## 免责声明

This is a personal hobby project, provided as-is without any warranty. It is
not an official product of Feishu, Lark, ByteDance, or OpenClaw.

这是一个个人兴趣项目，按"现状"提供，不附带任何担保。本项目与飞书/Lark、
字节跳动、OpenClaw 官方团队无隶属关系，出现问题请通过 GitHub Issues 反馈。
