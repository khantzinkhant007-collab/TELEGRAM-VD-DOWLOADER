# Deployment Guide — Telegram Video Batch Downloader (Vercel & AWS)

This guide covers deploying the **Telegram Video Batch Downloader** across two primary cloud targets:
1. **Vercel (Serverless + Edge CDN)** — Ideal for rapid zero-config deployments, UI hosting, link resolution, and small/medium video downloads.
2. **AWS (App Runner & ECS Fargate via Docker)** — Recommended for production workloads involving large multi-video `.zip` batch streams, long-lived MTProto TCP/WebSocket connections, and sustained high-bandwidth transfers.

---

## 1. Environment Variables Reference

Configure these variables in the **Vercel Project Settings -> Environment Variables** or **AWS Systems Manager Parameter Store / Secrets Manager** (never hardcode them in source files):

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `PORT` | No | `3000` | HTTP server port (automatically injected by Vercel / App Runner). |
| `NODE_ENV` | Yes | `production` | Set to `production` in all cloud environments. |
| `TELEGRAM_COOKIE_SECRET` | Production | *(empty)* | Random secret of at least 32 characters used to encrypt each browser's Telegram session cookie. Use the same value on every instance. |
| `ALLOWED_ORIGINS` | No | `*` / domain | Comma-separated list of allowed CORS origins (e.g., `https://tg-downloader.vercel.app`). |
| `MAX_BATCH_SIZE` | No | `25` | Maximum number of videos permitted in a single `POST /api/download-batch` request. |

Public posts with accessible Telegram video embeds work without account sign-in. Private links use your logged-in Telegram account and only work for channels and messages that account can access. The app no longer generates placeholder files when Telegram media is unavailable.

---

## 2. Deploying to Vercel

### Architecture on Vercel
- **Static Frontend (`public/*`)**: Served directly from Vercel's global CDN (`index.html`, `styles.css`, `app.js`).
- **Backend API (`api/index.js`)**: Wraps the Express `app` exported by `server.js` as a Vercel Node.js Serverless Function (`1024 MB` memory, `60s` max duration configured in `vercel.json`).
- **Security Headers**: `vercel.json` enforces `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `Cache-Control: no-store` on `/api/*`.

### Step-by-Step CLI Deployment
```bash
# 1. Install Vercel CLI (if not already installed)
npm i -g vercel

# 2. Link project in repository root
vercel link

# 3. Add a random Telegram session-cookie encryption secret
vercel env add TELEGRAM_COOKIE_SECRET production

# 4. Deploy to production
vercel --prod
```

### Vercel Operational Considerations & Limitations
- **Streaming Downloads**: Individual MTProto MP4 downloads and ZIP archives stream through the function to avoid buffering the full media payload in memory.
- **Per-Browser Sessions**: The Telegram API ID/hash and authorized session are encrypted into an HttpOnly, SameSite cookie for the signed-in browser. `TELEGRAM_COOKIE_SECRET` must be configured before sign-in and remain stable across deployments and function instances.
- **Large Video Batches**: For multi-hundred-megabyte MP4 streams and large `.zip` archive streaming, deploy the included `Dockerfile` to **AWS App Runner** or **AWS ECS Fargate** (see Section 3 below and `aws-deploy.md`).

---

## 3. Deploying to AWS (App Runner & ECS Fargate)

Container-based deployment on AWS avoids Vercel's buffered response ceiling for ZIP downloads and supports long-lived MTProto connections.

### Quick Local Verification with Docker Compose
```bash
# Copy environment template
cp .env.example .env

# Build and start hardened container (non-root user `node`, read-only rootfs, cap_drop: ALL)
docker compose up --build -d

# Verify health endpoint
curl http://localhost:3000/api/health
```

### AWS ECR + App Runner Quickstart
```bash
# 1. Authenticate Docker to Amazon ECR
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 2. Create repository & push production image
aws ecr create-repository --repository-name telegram-vd-downloader --image-scanning-configuration scanOnPush=true --region $AWS_REGION
docker build -t telegram-vd-downloader:latest .
docker tag telegram-vd-downloader:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/telegram-vd-downloader:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/telegram-vd-downloader:latest
```

Once pushed to ECR:
- **AWS App Runner**: Create an App Runner service pointing to `$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/telegram-vd-downloader:latest`, set Port to `3000`, and configure health check path `/api/health`.
- **AWS ECS Fargate**: See [aws-deploy.md](./aws-deploy.md) for full ECS Task Definition JSON, ALB timeout tuning (`idle_timeout.timeout_seconds = 300`), and AWS Secrets Manager ARN injection.
