# Troubleshooting

## Railway build fails

Confirm `railway.toml`, `Dockerfile.railway`, `package.json` and `package-lock.json` are in repository root. Inspect the first failing Docker layer.

## Health check fails

Verify `DATABASE_URL`, `SESSION_SECRET` and `SESSION_ENCRYPTION_KEY`. The database migration retries during startup. Do not define `PORT` manually on Railway.

## Remote browser is blank

Wait for deployment to finish, reopen the connection and inspect Railway logs for Xvfb, x11vnc or websockify errors. Only one interactive login session can run at once.

## Chromium exits or service restarts

This usually indicates memory pressure. Keep concurrency at one, use a smaller test video, increase Railway memory, and retain shared-memory configuration.

## YouTube asks for verification

Reconnect from Channel and complete the challenge in the remote Chrome window. The app reuses the same Chrome profile afterward, but Google can still request verification after password changes, recovery events, region/IP changes, or account-risk decisions. Keep the Railway service in the same region. For a fixed egress IP, enable Railway Static Outbound IP and redeploy.

## Upload stuck on UPLOADING

After the configured stale timeout it becomes REVIEW_REQUIRED. Inspect YouTube Studio before retrying.

## Optional setting warning

The channel or current Studio experiment did not expose that control. The core upload may still be complete. Review the uploaded video and update the selector only after capturing the current UI.
