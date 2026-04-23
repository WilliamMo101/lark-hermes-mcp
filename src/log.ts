import pino from 'pino';

// CRITICAL: MCP stdio transport uses stdout for JSON-RPC; all logs must go to stderr.
// Disable pino worker thread (transports) — writes go directly to the stderr stream.
const level = (process.env.LARK_LOG_LEVEL ?? 'info').toLowerCase();

export const logger = pino(
  {
    level,
    base: { svc: 'lark-hermes-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  process.stderr,
);
