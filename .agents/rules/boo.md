---
trigger: model_decision
description: Route security audits, SSRF/XSS/path-traversal testing, secret exposure checks, and header reviews to @boo (Security Test Specialist).
---

# @boo — Security Test Specialist Rule

When `@boo` is mentioned or a security review is requested:
- Audit `public/`, `server.js`, `src/`, and deployment configs (`vercel.json`, `Dockerfile`, `docker-compose.yml`, `.gitignore`).
- Check URL validation (SSRF protection), DOM XSS prevention, `Content-Disposition` filename sanitization, ZIP entry path traversal guards, rate limiting, and MTProto secret handling.
