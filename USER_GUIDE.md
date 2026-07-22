# Customer user guide

## Connect a channel

Open **Channel -> Connect YouTube Studio**. Sign in only inside the remote Google/YouTube page. Complete verification and wait for the Studio dashboard. Return and save the connection. The application stores encrypted browser state, not the Google password.

## Upload media

Use Media Library to upload:

- Videos: MP4, MOV, WebM or MKV.
- Thumbnails: JPG, PNG or WebP.
- Captions: SRT or VTT.

Files are isolated by customer account and are not publicly served.

## Create a Video or Short

Open Create and move the animated slider between Video and Short. Choose the source video, optional thumbnail/captions, metadata, automation start, visibility and policy controls. Shorts must be vertical or square and at most three minutes. Premiere is available only for Video.

`Automation date/time` controls when the backend starts uploading. For YouTube `SCHEDULE`, also provide a later YouTube publish date/time.

## Excel workflow

Use the supplied workbook. Add long-form items to `Videos` and vertical/square short-form items to `Shorts`. Upload media first or import first; missing filenames become FILE_MISSING and automatically return to READY when a matching video is uploaded.

## Statuses

- READY: waiting for automation time.
- UPLOADING: backend Chromium is working.
- UPLOADED: YouTube reported a completed save/publish/schedule action.
- PAUSED: disabled by the user.
- FILE_MISSING: matching source video is absent.
- LOGIN_REQUIRED: reconnect YouTube.
- ACCOUNT_ACTION_REQUIRED: Google needs OTP, CAPTCHA or identity confirmation.
- REVIEW_REQUIRED: outcome was uncertain; inspect YouTube before retrying.
- FAILED: attempts were exhausted or a non-recoverable validation failed.

## Optional settings and warnings

YouTube changes controls based on channel, country, eligibility, content type and experiments. If an optional setting is absent, the worker records a warning and continues. Audience, title, file selection and visibility are treated as required and fail visibly if unavailable.
