import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './log.js';
import { getLarkClient } from './auth.js';
import { loadAllTools, filterByToolsets } from './adapter/index.js';
import { enabledToolsets } from './toolsets.js';
import { throttle } from './util/throttle.js';

// -----------------------------------------------------------------------------
// CRITICAL: MCP stdio transport uses stdout for JSON-RPC.
// Any stray console.log / warn / info to stdout *will* corrupt the protocol.
// Route everything to pino → stderr before doing ANYTHING else.
// -----------------------------------------------------------------------------
const origConsole = { ...console };
console.log = (...a: unknown[]) => logger.info(a.map((x) => String(x)).join(' '));
console.info = (...a: unknown[]) => logger.info(a.map((x) => String(x)).join(' '));
console.warn = (...a: unknown[]) => logger.warn(a.map((x) => String(x)).join(' '));
console.error = (...a: unknown[]) => logger.error(a.map((x) => String(x)).join(' '));
console.debug = (...a: unknown[]) => logger.debug(a.map((x) => String(x)).join(' '));

void origConsole; // keep around for debugging

async function main(): Promise<void> {
  const bundle = getLarkClient();
  const enabled = enabledToolsets(process.env.LARK_ENABLED_TOOLSETS);
  logger.info({ enabled: [...enabled] }, 'enabled toolsets');

  const allTools = loadAllTools(bundle, logger);
  const tools = filterByToolsets(allTools, enabled);
  logger.info(
    {
      count: tools.size,
      fallback: [...tools.values()].filter((t) => t.source === 'fallback').length,
      shim: [...tools.values()].filter((t) => t.source === 'openclaw-shim').length,
      oauth: [...tools.keys()].filter((n) => n.startsWith('lark_oauth_')).length,
      names: [...tools.keys()],
    },
    'tools registered',
  );

  const server = new Server(
    { name: 'lark', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const spec = tools.get(name);
    if (!spec) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    const parsed = spec.validate(req.params.arguments ?? {});
    if (!parsed.ok) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${name}: ${parsed.error}`,
      );
    }

    await throttle(spec.toolset);

    const started = Date.now();
    try {
      const result = await spec.handler(parsed.data, {
        client: bundle.client,
        logger: logger.child({ tool: name, src: spec.source }),
        appId: bundle.appId,
        domain: bundle.domain,
      });
      logger.info({ tool: name, src: spec.source, ms: Date.now() - started }, 'tool ok');
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const e = err as {
        message?: string;
        code?: number | string;
        hint?: string;
        details?: unknown;
      };
      logger.error(
        {
          tool: name,
          src: spec.source,
          ms: Date.now() - started,
          err: e.message,
          code: e.code,
        },
        'tool failed',
      );
      // Return the error as a tool-level result so the LLM can reason about it,
      // rather than an MCP protocol error.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: e.message ?? String(err),
                code: e.code ?? 'unknown',
                hint: e.hint,
                details: e.details,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('lark-hermes-mcp ready on stdio');
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
  process.exit(1);
});
