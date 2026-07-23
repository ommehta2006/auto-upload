# Deploy YouTubePilot on Railway

## 1. Prepare the repository

1. Extract the project ZIP.
2. Create a **private** GitHub repository.
3. Upload the contents of the `youtubepilot` folder so `railway.toml`, `Dockerfile.railway` and `package.json` are at repository root.
4. Never commit `.env`, `.env.local`, `storage/`, `tmp/` or exported browser state.

## 2. Create the Railway project

1. Open Railway and choose **New Project -> Empty Project**.
2. Select **Add -> Database -> PostgreSQL**.
3. Wait for PostgreSQL to become available.
4. Select **Add -> GitHub Repo**, then choose the private repository.
5. Railway reads `railway.toml` and builds `Dockerfile.railway`.

## 3. Generate secrets

Run locally from the project folder:

```bash
node deploy/generate-railway-secrets.mjs
```

Copy the three generated values into the application service **Variables** page:

```text
NODE_ENV=production
COOKIE_SECURE=true
TRUST_PROXY=true
BROWSER_HEADLESS=false
BROWSER_LOCALE=en-US
BROWSER_TIMEZONE=Asia/Kolkata
WORKER_INTERVAL_SECONDS=20
WORKER_CONCURRENCY=1
MAX_VIDEO_MB=250
MAX_IMAGE_MB=10
MAX_CAPTION_MB=5
MAX_EXCEL_MB=10
MAX_STORAGE_MB_PER_USER=400
LOGIN_SESSION_MINUTES=20
RAILWAY_SHM_SIZE_BYTES=268435456
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
SESSION_SECRET=<generated>
SESSION_ENCRYPTION_KEY=<generated>
SIGNUP_INVITE_CODE=<generated>
```

Add a reference variable named `DATABASE_URL` from the PostgreSQL service. Do not manually create `PORT`; Railway supplies it.

## 4. Add persistent storage

Open the application service and create a volume mounted exactly at:

```text
/app/storage
```

The database remains in the PostgreSQL service. The volume stores customer videos, thumbnails, caption files, failure screenshots and each user's persistent Chrome profile. Railway trial/free storage is small, so use one short test video and delete it after testing.

## 5. Generate a public domain

Open **Application service -> Settings -> Networking -> Generate Domain**.

The application automatically uses `RAILWAY_PUBLIC_DOMAIN`. Open:

```text
https://YOUR-DOMAIN/health
```

Expected response:

```json
{"status":"ok","time":"..."}
```

Keep the application service in one Railway region for the lifetime of the YouTube connection. If the Google account is sensitive to IP changes, enable **Static Outbound IP** for the application service and redeploy before the first YouTube login.

## 6. First controlled test

1. Register with the private `SIGNUP_INVITE_CODE`.
2. Upload one small MP4.
3. Add a Video or Short mission at least ten minutes in the future.
4. Select Private or Unlisted for the first test.
5. Connect YouTube Studio from the Channel section.
6. In the remote browser, complete Google login, OTP, CAPTCHA and channel selection until Studio dashboard is visible.
7. Return to YouTubePilot and click **Save encrypted connection**. The same Chrome profile is reused for future uploads.
8. Close your local browser and laptop if desired.
9. After the automation time, reopen YouTubePilot and inspect Queue and Activity.

Expected state flow:

```text
READY -> UPLOADING -> UPLOADED
```

Uncertain publish results become `REVIEW_REQUIRED`; inspect YouTube Studio before retrying to prevent duplicates.

## 7. Railway logs

Application startup should show:

```text
Database migration completed.
YouTubePilot listening on port 3001
```

The public Railway port is handled by Caddy. The remote browser is proxied through `/remote/` on the same public domain.

## 8. Resource limitations

Chromium, Xvfb, noVNC, Node.js and video uploads are heavier than a standard website. A free/trial plan can validate the workflow but is not a reliable production tier. If Chromium is killed for memory, lower `WORKER_CONCURRENCY` to `1`, upload smaller videos, or move to a paid service/VM with more memory and disk.

## 9. Update deployment

Push changes to the connected GitHub branch. Railway builds a new image and uses `/health` as the deployment health check. A service with an attached volume may have brief downtime during redeployment.
