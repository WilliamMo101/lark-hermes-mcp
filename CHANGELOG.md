# Changelog

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-23

### Added
- Initial public release.
- **17 fallback tools** covering messaging, bitable, calendar, docs, and task operations.
- **36 tools bridged from `@larksuite/openclaw-lark`** via the shim adapter (`src/adapter/shim.ts`).
- **4 OAuth tools** (`lark_oauth_start` / `lark_oauth_complete` / `lark_oauth_status` / `lark_oauth_revoke`) driving OpenClaw's Device Flow for user-access-token (UAT) authorization.
- OpenAI function-calling compatibility layer: flattens top-level `anyOf` / `oneOf` union schemas into single object schemas while preserving strict runtime validation via typebox `Value.Check`.
- Post-install patches (`scripts/postinstall-patches.mjs`) that make `@larksuite/openclaw-lark` load cleanly under Node 22 CJS.

### Notes
- Depends on [`@larksuite/openclaw-lark`](https://www.npmjs.com/package/@larksuite/openclaw-lark) (MIT License). The postinstall script patches CJS-incompatible syntax inside `node_modules/` only; upstream source is not modified.
