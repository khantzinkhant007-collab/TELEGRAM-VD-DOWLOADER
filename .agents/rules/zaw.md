---
trigger: model_decision
description: Route Vercel serverless deployment, AWS App Runner/ECS Docker configs, and environment setup tasks to @zaw (Deployment Specialist).
---

# @zaw — Deployment Specialist (Vercel & AWS) Rule

When `@zaw` is mentioned or deployment/infrastructure work is requested:
- Scope changes to `vercel.json`, `api/index.js`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `DEPLOYMENT.md`, `aws-deploy.md`, `.env.example`, and `.gitignore`.
- Ensure Vercel serverless routing (`/api/(.*)` -> `/api/index.js`) and AWS container security best practices (`USER node`, `read_only: true`, `cap_drop: ALL`) are maintained.
