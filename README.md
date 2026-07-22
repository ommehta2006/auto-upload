# YouTubePilot Hosted Automation v1.0

YouTubePilot is a self-hosted customer application for scheduling YouTube Videos and Shorts with a backend Playwright browser. Customers upload private media, configure YouTube metadata through the UI or Excel, connect YouTube Studio once through an isolated remote browser, and can then close their laptop while the server runs the queue.

## Included

- Separate Video and Shorts workflows with an animated format slider.
- Title, description, tags, playlist, thumbnail and subtitle-file controls.
- Visibility, private/unlisted/public, YouTube scheduling and Premiere for long-form video.
- Audience, 18+ restriction, paid promotion and altered/synthetic content disclosure.
- Chapters, featured places, automatic concepts, language, caption certification, recording information and category.
- License, distribution, embedding and subscriber-notification controls.
- Comment moderation/sorting, likes, Shorts remixing and related-video controls.
- Excel import/export with Videos and Shorts sheets.
- Encrypted Playwright storage state using AES-256-GCM; Google passwords are never stored.
- PostgreSQL sessions, bcrypt password hashing, CSRF protection, rate limits, Helmet headers, MIME-signature validation and per-user private storage.
- Popup/coachmark dismissal, retry controls, screenshots and REVIEW_REQUIRED protection for uncertain results.
- Railway, Docker, Windows and macOS deployment assets.

## Architecture

```text
Customer browser
  -> Express/EJS customer dashboard
  -> PostgreSQL users, queue, logs and encrypted sessions
  -> private persistent media volume
  -> background worker
  -> headless Chromium
  -> YouTube Studio
```

The customer computer is only needed for dashboard access and occasional Google verification. Scheduled jobs execute on the server.

## Fast paths

- Railway: read `DEPLOY_RAILWAY.md`.
- Windows or macOS Docker Desktop: read `WINDOWS_MAC_GUIDE.md`.
- Customer usage: read `USER_GUIDE.md`.
- Verification: read `TESTING_CHECKLIST.md` and `BUILD_VALIDATION.md`.

## Important boundaries

YouTube Studio is not a stable public automation API. The code uses layered selectors, generic popup dismissal and explicit uncertainty handling, but no browser automation can guarantee compatibility with every future UI change, experiment, CAPTCHA or account-specific control. Unsupported optional settings are saved as warnings; required controls fail visibly. Always test with a private or unlisted upload before customer use.

Shorts are prevalidated as square/vertical videos not longer than 180 seconds. YouTube makes the final classification.
