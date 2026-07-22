# Security model

- Customer passwords use bcrypt with cost 12.
- Login sessions live in PostgreSQL and use HttpOnly, SameSite=Lax cookies; Secure cookies are enabled in production.
- Every state-changing request uses a per-session CSRF token, including multipart uploads.
- Authentication and upload endpoints are rate limited.
- Google credentials are entered only in the remote Google/YouTube browser. They are never accepted by an application form.
- Each YouTube channel uses one long-lived Chromium profile under persistent storage. Playwright storage state is encrypted with AES-256-GCM only as an emergency backup; the persistent browser profile is the primary session mechanism.
- Remote YouTube Studio access is launched through authenticated application routes. The noVNC websocket token is stored in a private temporary token file and rotated each time the owner opens the secure browser route, so previously copied raw noVNC URLs stop reconnecting after a new launch is issued.
- Customer files use randomized server names, MIME-signature checks, private filesystem permissions and account-scoped database lookups.
- Relative paths are checked against the storage root to prevent traversal.
- Helmet security headers, a restrictive Content Security Policy and disabled framework banners are enabled.
- Logs truncate messages and never intentionally include passwords or raw cookies.
- Screenshots may contain Studio metadata. They are private, account-scoped and pruned automatically.

## Google verification limitation

This architecture greatly reduces repeated Google verification by preserving the same browser identity, but Google may still request verification after IP changes, password changes, unusual activity, security-policy changes or risk signals.

## Production recommendations

Use a unique encryption key and session secret per environment. Restrict GitHub and Railway project access. Keep PostgreSQL and media backups encrypted. Rotate the invitation code before onboarding a new customer group. Do not use a single Railway service for many simultaneous channel logins; the noVNC connection manager intentionally permits one interactive login at a time.
