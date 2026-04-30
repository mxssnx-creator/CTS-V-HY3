# Deployment Guide

## Issue: Engines Stopping After Minutes

### Root Cause
This application uses long-running timers (`setTimeout` loops) for the trade engine. In Vercel's serverless environment:
- Functions are killed after ~5-15 minutes of inactivity
- The cron job restarts engines every 2 minutes, but there's downtime
- This causes "Progressions are Stopping / Restarting"

### Solution 1: Deploy to a Long-Running VPS (Recommended)

For production use with continuous engine processing, deploy to a VPS:

#### Option A: Using systemd (Ubuntu/Debian)

1. **Install dependencies:**
```bash
sudo apt update
sudo apt install -y nodejs npm redis-server
curl -fsSL https://bun.sh/install | bash
```

2. **Clone and setup:**
```bash
git clone <your-repo>
cd <your-repo>
bun install
bun run build
```

3. **Create systemd service file:**
```bash
sudo nano /etc/systemd/system/trade-engine.service
```

Add this content:
```ini
[Unit]
Description=Trade Engine Next.js App
After=redis.service network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/your/app
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=REDIS_URL=redis://localhost:6379
# Add other env vars from .env.local

[Install]
WantedBy=multi-user.target
```

4. **Start the service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable trade-engine
sudo systemctl start trade-engine
sudo systemctl status trade-engine
```

5. **Setup Redis to start on boot:**
```bash
sudo systemctl enable redis
sudo systemctl start redis
```

#### Option B: Using PM2 (Easier)

```bash
npm install -g pm2
pm2 start "bun run start" --name trade-engine
pm2 save
pm2 startup
```

### Solution 2: Increase Cron Frequency (Vercel Only)

If you must use Vercel, reduce downtime by increasing cron frequency:

Edit `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/engine-auto-start",
      "schedule": "*/1 * * * *"
    }
  ]
}
```

This changes from every 2 minutes to every 1 minute (reduces max downtime).

### Solution 3: Architecture Change (Not Recommended)

Change from long-running timers to cron-based batch processing:
- Remove `setTimeout` loops
- Each cron invocation does one cycle of work
- State is persisted in Redis between invocations

This requires significant refactoring and reduces processing frequency.

## Current Fixes Applied

1. ✅ Fixed indication processor to ALWAYS reschedule after errors
2. ✅ Fixed ESLint react-hooks configuration
3. ✅ TypeScript check passes
4. ✅ Build succeeds (169 pages)

## Verification

After deploying to a VPS with systemd/PM2:
```bash
# Check engine is running
curl http://localhost:3002/api/health

# Check engine stats
curl http://localhost:3002/api/trade-engine/status

# View logs
sudo journalctl -u trade-engine -f
# OR if using PM2:
pm2 logs trade-engine
```
