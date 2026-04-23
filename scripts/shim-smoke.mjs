import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET ?? 'xxx';
if (!APP_ID) {
  console.error('LARK_APP_ID env var is required for the smoke test.');
  console.error('Example: LARK_APP_ID=cli_xxxxxxxxxxxxxxxx node scripts/shim-smoke.mjs');
  process.exit(1);
}

const registered = [];
const api = {
  config: {
    channels: {
      feishu: {
        appId: APP_ID,
        appSecret: APP_SECRET,
        tools: { doc: true, wiki: true, drive: true, sheets: true, mail: true, perm: false, okr: false, scopes: true },
      },
    },
  },
  logger: { debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: ()=>{} },
  registerTool: (t) => { registered.push({ name: t.name, description: (t.description ?? '').slice(0, 60) }); },
  registerCommand: () => {},
  registerInteractiveHandler: () => {},
  registerChannel: () => {},
};

const OAPI = require('@larksuite/openclaw-lark/src/tools/oapi/index.js');
const MCPDoc = require('@larksuite/openclaw-lark/src/tools/mcp/doc/index.js');
const OAuth = require('@larksuite/openclaw-lark/src/tools/oauth.js');
const OAuthBatch = require('@larksuite/openclaw-lark/src/tools/oauth-batch-auth.js');

OAPI.registerOapiTools(api);
MCPDoc.registerFeishuMcpDocTools(api);
OAuth.registerFeishuOAuthTool(api);
OAuthBatch.registerFeishuOAuthBatchAuthTool(api);

console.log('TOTAL:', registered.length);
for (const t of registered) console.log('  ', t.name.padEnd(40), '─', t.description);
