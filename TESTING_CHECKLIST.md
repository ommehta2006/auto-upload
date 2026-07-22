# Acceptance checklist

## Static and security

- `npm ci`
- `npm run check`
- `npm test`
- `npm audit --omit=dev`
- Confirm `.env`, `.env.local`, storage and browser state are not committed.

## Dashboard

- Register and log in.
- Verify cinematic canvas respects reduced-motion settings.
- Switch Video/Short and confirm format-specific fields change.
- Confirm schedule fields appear only for SCHEDULE visibility.
- Upload valid and invalid video/image/caption files.
- Confirm duplicate filenames and quota errors are understandable.
- Import the supplied Excel template and export the queue.

## Channel connection

- Start remote Studio.
- Complete Google verification.
- Save connection only after Studio dashboard appears.
- Disconnect and verify encrypted state is removed.

## Video test

- Use a small MP4, Private visibility and no optional settings.
- Verify READY -> UPLOADING -> UPLOADED.
- Confirm title and description in Studio.

## Shorts test

- Use a vertical or square file no longer than 180 seconds.
- Verify a landscape file or longer file is rejected before browser launch.
- Confirm YouTube classifies the uploaded file as a Short.

## Failure tests

- Expire the Google session and expect LOGIN_REQUIRED.
- Force a browser interruption during final save and expect REVIEW_REQUIRED.
- Verify screenshots are downloadable only by the owning user.
- Retry only after checking Studio for duplicates.
