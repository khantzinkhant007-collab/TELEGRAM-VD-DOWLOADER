# AWS Production Deployment Runbook (`aws-deploy.md`)

This runbook details deploying the **Telegram Video Batch Downloader** to **AWS App Runner** and **Amazon ECS Fargate** using the hardened multi-stage `Dockerfile`.

---

## 1. Why AWS for Heavy Telegram Video Batching?

While **Vercel** (`vercel.json` + `api/index.js`) is ideal for instant previews and lightweight clips, Telegram videos and multi-video albums frequently range from `20 MB` to `2 GB`. Deploying on **AWS App Runner** or **AWS ECS Fargate**:
1. **Avoids the Serverless Response Cap**: Allows chunked HTTP streaming of large MP4 files (`GET /api/download`) and larger buffered `.zip` archives (`POST /api/download-batch`).
2. **Maintains Warm MTProto Socket Connections**: Teleproto keeps a reusable connection to Telegram data centers, reducing repeated authentication handshakes.
3. **Container Security Hardening**: Our `Dockerfile` runs as non-root `USER node` on `node:20-alpine` with zero dev dependencies and a built-in Node healthcheck against `/api/health`.

---

## 2. Storing Credentials in AWS Secrets Manager

Store the cookie-encryption secret in **AWS Secrets Manager**:

```bash
export AWS_REGION="us-east-1"

aws secretsmanager create-secret \
  --name "prod/telegram-vd-downloader/session-cookie" \
  --description "Telegram session cookie encryption secret" \
  --secret-string '{"TELEGRAM_COOKIE_SECRET":"YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS"}' \
  --region $AWS_REGION
```

---

## 3. Option A: AWS App Runner (Recommended Managed Container Service)

AWS App Runner provides automatic HTTPS, load balancing, and autoscaling directly from Amazon ECR.

### App Runner Configuration Parameters
- **Source**: Amazon ECR (`telegram-vd-downloader:latest`)
- **Port**: `3000`
- **CPU / Memory**: `1 vCPU` / `2 GB RAM`
- **Health Check**:
  - Protocol: `HTTP`
  - Path: `/api/health`
  - Interval: `20s`
  - Timeout: `5s`
  - Healthy threshold: `1`, Unhealthy threshold: `3`
- **Request Timeout**: Increase to `120s` for large batch ZIP downloads.
- **Environment Variables**:
  - `NODE_ENV=production`
  - `PORT=3000`
  - `TELEGRAM_COOKIE_SECRET` referenced via Secrets Manager ARN.

---

## 4. Option B: Amazon ECS Fargate + Application Load Balancer (ALB)

For large multi-video archives requiring timeouts > 120 seconds, deploy on **ECS Fargate** behind an **Application Load Balancer**.

### ECS Fargate Task Definition (`ecs-task-def.json` Reference)
```json
{
  "family": "telegram-vd-downloader",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "telegram-vd-downloader",
      "image": "<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/telegram-vd-downloader:latest",
      "essential": true,
      "user": "node",
      "readonlyRootFilesystem": true,
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" },
        { "name": "MAX_BATCH_SIZE", "value": "25" }
      ],
      "secrets": [
        {
          "name": "TELEGRAM_COOKIE_SECRET",
          "valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:prod/telegram-vd-downloader/session-cookie:TELEGRAM_COOKIE_SECRET::"
        }
      ],
      "linuxParameters": {
        "initProcessEnabled": true,
        "capabilities": {
          "drop": ["ALL"]
        },
        "tmpfs": [
          {
            "containerPath": "/tmp",
            "size": 256,
            "mountOptions": ["rw", "noexec", "nosuid"]
          }
        ]
      },
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "node -e \"const http = require('http'); const req = http.get('http://127.0.0.1:3000/api/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1));\""
        ],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/telegram-vd-downloader",
          "awslogs-region": "<REGION>",
          "awslogs-stream-prefix": "ecs",
          "awslogs-create-group": "true"
        }
      }
    }
  ]
}
```

### Critical ALB Tuning for Streaming ZIP Downloads
1. **ALB Idle Timeout**: Increase `idle_timeout.timeout_seconds` from the default `60` seconds to `300` seconds so large batch `.zip` downloads over slower mobile/residential connections are not prematurely terminated:
   ```bash
   aws elbv2 modify-load-balancer-attributes \
     --load-balancer-arn <ALB_ARN> \
     --attributes Key=idle_timeout.timeout_seconds,Value=300
   ```
2. **Target Group Health Check**:
   - Path: `/api/health`
   - Matcher: `200`
   - Deregistration delay: `60` seconds (allows active video streams to finish cleanly during rolling deployments).
