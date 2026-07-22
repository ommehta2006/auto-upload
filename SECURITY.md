# Security model

- Customer passwords use bcrypt with cost 12.
- Login sessions live in PostgreSQL and use HttpOnly, SameSite=Lax cookies; Secure cookies are enabled in production.
- Every state-changing request uses a per-session CSRF token, including multipart uploads.
- Authentication and upload endpoints are rate limited.
- Google credentials are entered only in the remote Google/YouTube browser. They are never accepted by an application form.
- Playwright storage state is encrypted with AES-256-GCM. `SESSION_ENCRYPTION_KEY` must be backed up securely; losing it invalidates connections.
- Customer files use randomized server names, MIME-signature checks, private filesystem permissions and account-scoped database lookups.
- Relative paths are checked against the storage root to prevent traversal.
- Helmet security headers, a restrictive Content Security Policy and disabled framework banners are enabled.
- Logs truncate messages and never intentionally include passwords or raw cookies.
- Screenshots may contain Studio metadata. They are private, account-scoped and pruned automatically.

## Production recommendations

Use a unique encryption key and session secret per environment. Restrict GitHub and Railway project access. Keep PostgreSQL and media backups encrypted. Rotate the invitation code before onboarding a new customer group. Do not use a single Railway service for many simultaneous channel logins; the noVNC connection manager intentionally permits one interactive login at a time.
