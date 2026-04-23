import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './log.js';

const { Client, Domain, LoggerLevel } = lark;

export interface LarkClientBundle {
  client: lark.Client;
  appId: string;
  appSecret: string;
  domain: string;
}

function resolveDomain(raw: string | undefined): { value: lark.Domain; label: string } {
  const v = (raw ?? 'Feishu').trim();
  const lower = v.toLowerCase();
  if (lower === 'lark' || lower === 'global' || lower === 'international') {
    return { value: Domain.Lark, label: 'Lark' };
  }
  // default to Feishu (国内)
  return { value: Domain.Feishu, label: 'Feishu' };
}

let cached: LarkClientBundle | null = null;

export function getLarkClient(): LarkClientBundle {
  if (cached) return cached;

  const appId = process.env.LARK_APP_ID?.trim();
  const appSecret = process.env.LARK_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    const missing = [!appId && 'LARK_APP_ID', !appSecret && 'LARK_APP_SECRET']
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `lark-hermes-mcp: missing required credentials (${missing}). ` +
        `Set these in the mcp_servers.lark.env block of your Hermes profile config.yaml.`,
    );
  }

  const { value: domain, label } = resolveDomain(process.env.LARK_DOMAIN);

  const client = new Client({
    appId,
    appSecret,
    domain,
    // SDK's own logging — push everything through our pino (to stderr)
    loggerLevel: LoggerLevel.warn,
    disableTokenCache: false,
  });

  logger.info({ appId: redact(appId), domain: label }, 'lark-client initialized');

  cached = { client, appId, appSecret, domain: label };
  return cached;
}

export function redact(value: string | undefined | null): string {
  if (!value) return '(empty)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
