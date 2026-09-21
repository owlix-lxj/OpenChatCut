# Desktop video-link extraction

## WeChat Channels

- User experience: paste a public HTTPS share link, then automatically download
  media and run local Whisper. A title or description is never a transcript.
- Try the official anonymous feed request first. When it returns only metadata,
  use the public BugPk endpoint documented at
  https://api.bugpk.com/doc-wxsph.html (`GET /api/wxsph?url=...`).
- The provider currently labels the endpoint free and documents keyless calls.
  No API key, WeChat/Yuanbao account, cookie extraction, login UI, certificate
  installation or paid fallback is configured in AI-cut.
- Only the canonical public `https://weixin.qq.com/sph/<id>` link is sent to
  BugPk. Other query parameters, private feed tokens, editor sessions, files and
  transcript text are not sent. The UI discloses this third-party resolution.
- This is an external service dependency, **not** a self-hosted anonymous
  implementation. Its internal authentication mechanism is unknown. Free access,
  uptime and future terms are not guaranteed. Do not silently switch to paid or
  credential-based providers if this service stops working.
- On service/HTTP 429, retry at most twice, observing the reported delay (up to
  10 seconds; longer delays stop and display a retry-later message). Every request
  has a 35-second timeout. No arbitrary redirect targets are fetched.
- Accept only validated Tencent video CDN URLs, not covers or preview pages.
  Download with the existing public-address validator, enforce 500 MB and time
  limits, and verify an audio track with ffprobe before local transcription.

## Verification

`npx tsx desktop/wechat-public-resolver.verify.ts`

Tests cover canonical links, no credentials, explicit fallback wiring, title-only
responses, untrusted URLs, HTTP/service throttling, malformed responses and bounded
retry behavior. Live availability must be checked independently of fixture tests.

Live check (2026-09-19): pasting the user-provided public WeChat share into the
rebuilt AI-cut development app automatically started resolution, downloaded the
video, and produced 65 characters of local Whisper speech transcription. No
extract-button click, browser window, login or API key was needed. The AI rewrite
form became available; cloud rewriting was not invoked. This verifies that sample
at that time, not universal availability of every WeChat video.
