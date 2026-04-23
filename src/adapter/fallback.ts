// Hand-written MCP tools using @larksuiteoapi/node-sdk directly.
// v0.1 covers the high-value essentials: messaging / bitable / calendar / docs + self-check.
//
// Each tool:
//   - name        : unique (becomes `mcp_lark_<name>` on the Hermes side)
//   - toolset     : for throttling + enable/disable gating
//   - description : shown to the LLM
//   - schema      : Zod (converted to JSON Schema for MCP `inputSchema`)
//   - handler     : async (args, ctx) => result (JSON-serializable)

import { z } from 'zod';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import type { Toolset } from '../toolsets.js';
import { redact } from '../auth.js';

export interface ToolCtx {
  client: Client;
  logger: Logger;
  appId: string;
  domain: string;
}

export interface ToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  toolset: Toolset;
  description: string;
  schema: S;
  handler: (args: z.infer<S>, ctx: ToolCtx) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

const sendMessageFeishu: ToolSpec = {
  name: 'sendMessageFeishu',
  toolset: 'messaging',
  description:
    '【飞书 IM】发送一条消息到指定聊天 / 用户 / 邮箱 / open_id / union_id。receive_id_type 决定 receive_id 的含义(chat_id / open_id / union_id / user_id / email),msg_type 支持 text / post / image / interactive / share_chat / share_user / audio / media / file / sticker。content 必须是 msg_type 对应的 JSON 字符串(例如 text 为 {"text":"hello"})。',
  schema: z.object({
    receive_id_type: z.enum(['open_id', 'user_id', 'union_id', 'email', 'chat_id']),
    receive_id: z.string().min(1),
    msg_type: z.string().min(1).default('text'),
    content: z
      .string()
      .describe('JSON string matching msg_type shape; text -> {"text":"..."}'),
    uuid: z.string().optional(),
  }),
  async handler(args, { client, logger }) {
    logger.info(
      {
        receive_id_type: args.receive_id_type,
        receive_id_redacted: redact(args.receive_id),
        msg_type: args.msg_type,
      },
      'im.message.create',
    );
    const res = await client.im.v1.message.create({
      params: { receive_id_type: args.receive_id_type },
      data: {
        receive_id: args.receive_id,
        msg_type: args.msg_type,
        content: args.content,
        uuid: args.uuid,
      },
    });
    return res;
  },
};

const sendCardFeishu: ToolSpec = {
  name: 'sendCardFeishu',
  toolset: 'messaging',
  description:
    '【飞书 IM】发送一张交互式卡片(interactive)。card 必须是飞书卡片 JSON 字符串(含 header/elements 或 template_id + template_variable)。',
  schema: z.object({
    receive_id_type: z.enum(['open_id', 'user_id', 'union_id', 'email', 'chat_id']),
    receive_id: z.string().min(1),
    card: z.string().describe('JSON string of a Feishu interactive card body'),
  }),
  async handler(args, { client }) {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: args.receive_id_type },
      data: {
        receive_id: args.receive_id,
        msg_type: 'interactive',
        content: args.card,
      },
    });
    return res;
  },
};

const replyMessageFeishu: ToolSpec = {
  name: 'replyMessageFeishu',
  toolset: 'messaging',
  description: '【飞书 IM】回复指定 message_id 的消息。reply_in_thread=true 时在话题里回复。',
  schema: z.object({
    message_id: z.string().min(1),
    msg_type: z.string().default('text'),
    content: z.string(),
    reply_in_thread: z.boolean().optional(),
    uuid: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.im.v1.message.reply({
      path: { message_id: args.message_id },
      data: {
        msg_type: args.msg_type,
        content: args.content,
        reply_in_thread: args.reply_in_thread,
        uuid: args.uuid,
      },
    });
    return res;
  },
};

const listMessagesFeishu: ToolSpec = {
  name: 'listMessagesFeishu',
  toolset: 'messaging',
  description: '【飞书 IM】列出指定 container(通常是 chat_id)最近的消息。容器类型默认 chat。',
  schema: z.object({
    container_id: z.string().min(1),
    container_id_type: z.string().default('chat'),
    start_time: z.string().optional().describe('10-digit unix seconds'),
    end_time: z.string().optional().describe('10-digit unix seconds'),
    page_size: z.number().int().min(1).max(50).optional(),
    page_token: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.im.v1.message.list({
      params: {
        container_id_type: args.container_id_type,
        container_id: args.container_id,
        start_time: args.start_time,
        end_time: args.end_time,
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
    return res;
  },
};

// ---------------------------------------------------------------------------
// bitable
// ---------------------------------------------------------------------------

const bitableListRecords: ToolSpec = {
  name: 'bitableListRecords',
  toolset: 'bitable',
  description:
    '【飞书多维表格】按页列出某张数据表的记录。支持 filter (飞书 filter DSL 字符串)、field_names、sort。',
  schema: z.object({
    app_token: z.string().min(1),
    table_id: z.string().min(1),
    view_id: z.string().optional(),
    filter: z.string().optional(),
    field_names: z.array(z.string()).optional(),
    sort: z
      .array(z.object({ field_name: z.string(), desc: z.boolean().optional() }))
      .optional(),
    page_size: z.number().int().min(1).max(500).optional(),
    page_token: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.bitable.v1.appTableRecord.list({
      path: { app_token: args.app_token, table_id: args.table_id },
      params: {
        view_id: args.view_id,
        filter: args.filter,
        field_names: args.field_names ? JSON.stringify(args.field_names) : undefined,
        sort: args.sort ? JSON.stringify(args.sort) : undefined,
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
    return res;
  },
};

const bitableCreateRecord: ToolSpec = {
  name: 'bitableCreateRecord',
  toolset: 'bitable',
  description:
    '【飞书多维表格】在指定数据表中创建一条记录。fields 为字段名 → 值的 JSON 字符串。',
  schema: z.object({
    app_token: z.string().min(1),
    table_id: z.string().min(1),
    fields: z.string().describe('JSON string: {"字段A":"val","字段B":123}'),
  }),
  async handler(args, { client }) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args.fields);
    } catch (e) {
      throw new Error(`invalid 'fields' JSON: ${(e as Error).message}`);
    }
    const res = await client.bitable.v1.appTableRecord.create({
      path: { app_token: args.app_token, table_id: args.table_id },
      data: { fields: parsed as any },
    });
    return res;
  },
};

const bitableUpdateRecord: ToolSpec = {
  name: 'bitableUpdateRecord',
  toolset: 'bitable',
  description:
    '【飞书多维表格】更新指定 record_id 的字段(部分更新)。fields 为要修改的字段 JSON。',
  schema: z.object({
    app_token: z.string().min(1),
    table_id: z.string().min(1),
    record_id: z.string().min(1),
    fields: z.string(),
  }),
  async handler(args, { client }) {
    const parsed = JSON.parse(args.fields);
    const res = await client.bitable.v1.appTableRecord.update({
      path: {
        app_token: args.app_token,
        table_id: args.table_id,
        record_id: args.record_id,
      },
      data: { fields: parsed as any },
    });
    return res;
  },
};

// ---------------------------------------------------------------------------
// calendar
// ---------------------------------------------------------------------------

const calendarListCalendars: ToolSpec = {
  name: 'calendarListCalendars',
  toolset: 'calendar',
  description: '【飞书日历】列出当前身份可见的日历(primary / exchange / google / resource)。',
  schema: z.object({
    page_size: z.number().int().min(1).max(1000).optional(),
    page_token: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.calendar.v4.calendar.list({
      params: {
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
    return res;
  },
};

const calendarCreateEvent: ToolSpec = {
  name: 'calendarCreateEvent',
  toolset: 'calendar',
  description:
    '【飞书日历】在指定日历下创建日程。start_time / end_time 为 10 位 unix 秒字符串;timezone 如 Asia/Shanghai。',
  schema: z.object({
    calendar_id: z.string().min(1),
    summary: z.string().min(1),
    description: z.string().optional(),
    start_time: z.string().describe('unix seconds (10 digits) as string'),
    end_time: z.string().describe('unix seconds (10 digits) as string'),
    timezone: z.string().default('Asia/Shanghai'),
    need_notification: z.boolean().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.calendar.v4.calendarEvent.create({
      path: { calendar_id: args.calendar_id },
      params: { user_id_type: 'open_id' },
      data: {
        summary: args.summary,
        description: args.description,
        need_notification: args.need_notification,
        start_time: { timestamp: args.start_time, timezone: args.timezone },
        end_time: { timestamp: args.end_time, timezone: args.timezone },
      },
    });
    return res;
  },
};

const calendarListEvents: ToolSpec = {
  name: 'calendarListEvents',
  toolset: 'calendar',
  description:
    '【飞书日历】列出指定日历在时间区间内的日程。start_time / end_time 为 10 位 unix 秒字符串。',
  schema: z.object({
    calendar_id: z.string().min(1),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    page_size: z.number().int().min(1).max(1000).optional(),
    page_token: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.calendar.v4.calendarEvent.list({
      path: { calendar_id: args.calendar_id },
      params: {
        start_time: args.start_time,
        end_time: args.end_time,
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
    return res;
  },
};

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

const docxGetRawContent: ToolSpec = {
  name: 'docxGetRawContent',
  toolset: 'docs',
  description: '【飞书文档 Docx】获取新版云文档的纯文本内容(去格式)。用于阅读/总结。',
  schema: z.object({
    document_id: z.string().min(1),
    lang: z.number().int().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.docx.v1.document.rawContent({
      path: { document_id: args.document_id },
      params: args.lang !== undefined ? { lang: args.lang } : {},
    });
    return res;
  },
};

const docxListBlocks: ToolSpec = {
  name: 'docxListBlocks',
  toolset: 'docs',
  description: '【飞书文档 Docx】列出文档根 block 或指定 block 的子结构(保留样式/层级)。',
  schema: z.object({
    document_id: z.string().min(1),
    page_size: z.number().int().min(1).max(500).optional(),
    page_token: z.string().optional(),
  }),
  async handler(args, { client }) {
    const res = await client.docx.v1.documentBlock.list({
      path: { document_id: args.document_id },
      params: {
        page_size: args.page_size,
        page_token: args.page_token,
      },
    });
    return res;
  },
};

// ---------------------------------------------------------------------------
// self-check (diagnostics)
// ---------------------------------------------------------------------------

const selfCheck: ToolSpec = {
  name: 'selfCheck',
  toolset: 'other',
  description:
    '【诊断】检查 lark-hermes-mcp 当前的配置、凭证可用性、tenant_access_token 能否获取。不依赖具体权限。',
  schema: z.object({}),
  async handler(_args, { client, appId, domain }) {
    const out: Record<string, unknown> = {
      appId: redact(appId),
      domain,
      node: process.version,
    };
    try {
      // Minimal call that forces tenant_access_token acquisition.
      // bot.info requires only "Obtain basic bot information" which Feishu grants by default.
      const res = (await (client.im as any).v1.chat.list({
        params: { page_size: 1, user_id_type: 'open_id' },
      })) as { code?: number; msg?: string };
      out.tenant_token_ok = res.code === 0;
      out.api_ping = { code: res.code, msg: res.msg };
    } catch (e) {
      out.tenant_token_ok = false;
      out.error = String(e);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export function getAllTools(): ToolSpec[] {
  return [
    // messaging
    sendMessageFeishu,
    sendCardFeishu,
    replyMessageFeishu,
    listMessagesFeishu,
    // bitable
    bitableListRecords,
    bitableCreateRecord,
    bitableUpdateRecord,
    // calendar
    calendarListCalendars,
    calendarCreateEvent,
    calendarListEvents,
    // docs
    docxGetRawContent,
    docxListBlocks,
    // other
    selfCheck,
  ];
}
