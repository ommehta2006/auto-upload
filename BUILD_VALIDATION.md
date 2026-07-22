# Build Validation Report

Validation target: YouTubePilot 1.0.0 on 21 July 2026.

## Passed in the build workspace

- `npm ci --ignore-scripts` completed.
- `npm audit --omit=dev` reported zero known vulnerabilities at validation time.
- JavaScript syntax passed for server, worker, browser automation, deployment and test scripts.
- Four automated core tests passed:
  - AES-256-GCM session round-trip and tamper rejection.
  - Shorts duration/orientation validation.
  - form scheduling and Premiere validation.
  - Videos/Shorts Excel parser validation using the supplied workbook.
- Six representative EJS pages rendered successfully, including the complete dashboard and edit composer.
- A real local Playwright-to-headless-Chromium smoke test passed.
- The 41-column Excel template was generated with formatted Videos and Shorts sheets, dropdown validation, Settings, Instructions and zero formula-error matches.
- The rendered dashboard was captured at 1440 px width for visual inspection; layout, responsive sections, animated hero canvas host and Video/Short selector were present.
- Shell syntax passed for Linux/macOS deployment scripts.
- `railway.toml` parsed successfully and points to the Railway Dockerfile and `/health` check.
- Sensitive runtime files, browser state, environment files and customer storage are excluded from the package and source-control patterns.

## Not executable without live infrastructure and an account

A real Google/YouTube account and Railway project are required to validate:

- Google login, OTP, CAPTCHA and account challenges in the temporary remote browser.
- Encrypted authenticated-state restoration in backend Chromium.
- Live YouTube Studio upload, processing, checks, visibility, scheduling and final URL capture.
- Channel-specific optional controls, including controls hidden by eligibility, geography or Studio experiments.
- Current YouTube Studio selector and popup variations.
- Railway PostgreSQL, volume persistence, WebSocket/noVNC routing, outbound access and memory usage.
- Windows and macOS Docker Desktop execution on physical customer machines.

## Release position

The package is ready for a controlled private proof-of-concept. Start with one small Private or Unlisted video. Treat `REVIEW_REQUIRED` as a duplicate-prevention state and inspect YouTube Studio before retrying. Browser automation cannot guarantee every future Studio UI or Google security challenge; missing optional controls are reported as warnings and required controls fail visibly.
