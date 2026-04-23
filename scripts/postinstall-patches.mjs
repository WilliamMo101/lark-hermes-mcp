#!/usr/bin/env node
/**
 * Idempotent post-install patches for @larksuite/openclaw-lark.
 *
 * 1. Fix version.js — Node 22 syntax-detects `import.meta.url` and flips the
 *    file to ESM, breaking `exports`. Replace with pure CJS impl.
 * 2. Fix token-store.js — same issue, one line fix.
 * 3. Create a minimal `openclaw/plugin-sdk` stub. OpenClaw treats this as a
 *    peer-dep-from-runtime; we stub `account-id` (the only part Feishu tools
 *    actually use) and throw-on-access Proxies for the rest.
 *
 * Running twice is safe — each step checks the existing file state first.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = join(__dirname, '..');
const OPENCLAW_ROOT = join(MCP_ROOT, 'node_modules', '@larksuite', 'openclaw-lark');
const SDK_STUB_ROOT = join(MCP_ROOT, 'node_modules', 'openclaw', 'plugin-sdk');

const log = (m) => console.log(`[postinstall] ${m}`);

// --- 1. Patch version.js -----------------------------------------------------
const versionPath = join(OPENCLAW_ROOT, 'src', 'core', 'version.js');
if (existsSync(versionPath)) {
  const src = readFileSync(versionPath, 'utf8');
  if (src.includes('import.meta') || src.includes('fileURLToPath')) {
    writeFileSync(versionPath, `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPluginVersion = getPluginVersion;
exports.getPlatform = getPlatform;
exports.getUserAgent = getUserAgent;
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
let cachedVersion;
function getPluginVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const packageJsonPath = (0, node_path_1.join)(__dirname, '..', '..', 'package.json');
    const raw = (0, node_fs_1.readFileSync)(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    cachedVersion = pkg.version ?? 'unknown';
  } catch { cachedVersion = 'unknown'; }
  return cachedVersion;
}
function getPlatform() {
  switch (process.platform) {
    case 'darwin': return 'mac';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}
function getUserAgent() {
  return \`openclaw-lark/\${getPluginVersion()}/\${getPlatform()}\`;
}
`);
    log('patched version.js (stripped ESM import.meta)');
  } else {
    log('version.js already patched, skip');
  }
} else {
  log(`WARN: version.js not found at ${versionPath}`);
}

// --- 2. Patch token-store.js -------------------------------------------------
const tokenStorePath = join(OPENCLAW_ROOT, 'src', 'core', 'token-store.js');
if (existsSync(tokenStorePath)) {
  let src = readFileSync(tokenStorePath, 'utf8');
  const needle = `const _require = (0, node_module_1.createRequire)(typeof __filename !== 'undefined' ? __filename : import.meta.url);`;
  const replacement = `const _require = (0, node_module_1.createRequire)(__filename);`;
  if (src.includes(needle)) {
    src = src.replace(needle, replacement);
    writeFileSync(tokenStorePath, src);
    log('patched token-store.js (stripped import.meta fallback)');
  } else if (src.includes(replacement)) {
    log('token-store.js already patched, skip');
  } else {
    log('WARN: token-store.js has unexpected shape, manual review needed');
  }
} else {
  log(`WARN: token-store.js not found at ${tokenStorePath}`);
}

// --- 3. Build openclaw/plugin-sdk stub --------------------------------------
mkdirSync(SDK_STUB_ROOT, { recursive: true });

const openclawPkg = join(MCP_ROOT, 'node_modules', 'openclaw', 'package.json');
if (!existsSync(openclawPkg)) {
  writeFileSync(openclawPkg, JSON.stringify({
    name: 'openclaw',
    version: '2026.3.22-stub',
    private: true,
  }, null, 2));
}

const subpaths = [
  'account-id', 'agent-runtime', 'allow-from', 'channel-feedback',
  'channel-runtime', 'channel-status', 'config-runtime', 'param-readers',
  'plugin-runtime', 'reply-history', 'reply-runtime', 'routing', 'setup',
  'temp-path', 'tool-send', 'zalouser',
];

const stubPkg = {
  name: 'openclaw-plugin-sdk-stub',
  version: '0.0.0',
  main: 'index.js',
  exports: Object.fromEntries([
    ['.', './index.js'],
    ...subpaths.map((s) => [`./${s}`, `./${s}.js`]),
  ]),
};
writeFileSync(join(SDK_STUB_ROOT, 'package.json'), JSON.stringify(stubPkg, null, 2));
writeFileSync(join(SDK_STUB_ROOT, 'index.js'),
  `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n`);

// account-id is the only subpath tools really need
writeFileSync(join(SDK_STUB_ROOT, 'account-id.js'), `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ACCOUNT_ID = "default";
exports.normalizeAccountId = function(id) {
  if (typeof id !== "string") return undefined;
  const t = id.trim().toLowerCase();
  return t || undefined;
};
`);

// All other subpaths — throw on access so unknown usage surfaces immediately
for (const sub of subpaths) {
  if (sub === 'account-id') continue;
  writeFileSync(join(SDK_STUB_ROOT, `${sub}.js`), `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
module.exports = new Proxy({ __esModule: true }, {
  get(target, prop) {
    if (prop === "__esModule") return true;
    throw new Error("openclaw/plugin-sdk/${sub}.\${String(prop)} is not stubbed");
  }
});
`);
}

log(`built openclaw/plugin-sdk stub at ${SDK_STUB_ROOT}`);

// --- 4. Widen @larksuite/openclaw-lark exports map ---------------------------
// The shipped package.json has `exports: { ".": { import: "./dist/index.mjs" } }`
// which (a) points at a non-existent dist/ and (b) blocks src/ subpath require.
// Replace with a permissive CJS main + wildcard subpath.
const larkPkgPath = join(OPENCLAW_ROOT, 'package.json');
if (existsSync(larkPkgPath)) {
  const pkg = JSON.parse(readFileSync(larkPkgPath, 'utf8'));
  const alreadyPatched = pkg.exports?.['./src/*'] === './src/*';
  if (!alreadyPatched) {
    pkg.main = './index.js';
    pkg.exports = {
      '.': './index.js',
      './src/*': './src/*',
      './package.json': './package.json',
    };
    writeFileSync(larkPkgPath, JSON.stringify(pkg, null, 2));
    log('widened openclaw-lark exports map (src/* now importable)');
  } else {
    log('openclaw-lark exports map already widened, skip');
  }
}

log('done.');
