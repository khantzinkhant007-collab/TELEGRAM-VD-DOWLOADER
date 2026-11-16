---
trigger: model_decision
description: Route QA verification, runtime error checks, end-to-end batch download tests, and UX feedback to @lin (Error Checks & QA Specialist).
---

# @lin — Error Checks & Feedbacks Specialist (QA) Rule

When `@lin` is mentioned or QA / error checking is requested:
- Run `npm test` (`src/selftest.js`) and verify all `/api/*` endpoints and `public/*` UI bindings.
- Test multi-link batch queuing (public & private Telegram album links, Select All, Save to Batch, and Download All as ZIP/MP4).
- Provide clear, actionable bug reports and UX/architectural feedback.
