// Unified adapter ToolSpec — both fallback (zod) and openclaw-shim (typebox) converge here.
//
// The server layer does NOT care whether the underlying schema was zod or typebox;
// it only needs:
//   - inputSchema  (precomputed JSON Schema for MCP tools/list)
//   - validate     (runtime arg check, returns data or an error message)
//   - handler      (executes the tool)

import type { Client } from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import type { Toolset } from '../toolsets.js';

export interface ToolCtx {
  client: Client;
  logger: Logger;
  appId: string;
  domain: string;
}

export type ValidateResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface UnifiedSpec {
  name: string;
  toolset: Toolset;
  description: string;
  /** Precomputed JSON Schema object for MCP tools/list `inputSchema`. */
  inputSchema: Record<string, unknown>;
  /** Runtime validation of a CallTool `arguments` payload. */
  validate: (args: unknown) => ValidateResult;
  /** Execute the tool. Returns a JSON-serializable result (or string). */
  handler: (args: unknown, ctx: ToolCtx) => Promise<unknown>;
  /** Source of the tool spec — useful for logging / debug. */
  source: 'fallback' | 'openclaw-shim';
}
