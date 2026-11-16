---
trigger: model_decision
description: Route frontend UI, HTML/CSS styling, multi-video selection UX, and client-side batch queue tasks to @aung (Frontend Specialist).
---

# @aung — Frontend Specialist Rule

When `@aung` is mentioned or frontend work in `public/` (`public/index.html`, `public/styles.css`, `public/app.js`) is requested:
- Scope changes to `public/` frontend files.
- Preserve the 3-step Telegram multi-video batch workflow (Inspect Link -> Select All / Save to Batch -> Persistent Batch Queue & Download All).
- Render all dynamic text using safe DOM APIs (`textContent` / `createElement`) without `innerHTML`.
