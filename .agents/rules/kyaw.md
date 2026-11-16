---
trigger: model_decision
description: Route backend Express API routes, Telegram URL/MTProto resolution, and MP4/ZIP streaming tasks to @kyaw (Backend Specialist).
---

# @kyaw — Backend Specialist Rule

When `@kyaw` is mentioned or backend work in `server.js`, `src/`, or `package.json` is requested:
- Scope changes to `server.js`, `src/telegramService.js`, `src/mediaBuilder.js`, `src/selftest.js`, and `package.json`.
- Maintain full compatibility with both local Express (`node server.js` on `http://localhost:3000`) and Vercel serverless (`api/index.js`).
- Run `npm test` (`src/selftest.js`) to verify all endpoints after changes.
