Read this before `submit_video({ model: "jimeng-avatar", … })`.

## What it does

This is the photo-avatar / talking-photo path. It uses one clear still image and one project audio asset to create a speaking presenter video. It does not require camera, mocap, or other hardware.

## Inputs

- `firstFrame`: exactly one project image asset. Use a front-facing, unobstructed single-person JPG, JPEG, or PNG.
- `refAudios`: exactly one project audio asset. MP3, WAV, M4A, and AAC are accepted; the real audio duration must be 15 seconds or less for one segment.
- `likenessConsent`: set `true` only after the user explicitly confirms that they own the likeness or have permission to create and use it, and will not use it for impersonation, fraud, or unlawful activity.
- `name`: a descriptive media-pool name.

Do not pass `prompt`, `durationSeconds`, `ratio`, `resolution`, `lastFrame`, `refImages`, `refVideos`, or ordinary video-generation controls. The output duration follows the audio.

## Workflow

1. Confirm the image and audio assets are already in the active project.
2. If the image depicts a recognizable real person, obtain the explicit likeness-consent confirmation immediately before submission. An upload alone is not consent.
3. Submit one `submit_video` job with `model: "jimeng-avatar"`, one `firstFrame`, one `refAudios`, and `likenessConsent: true`.
4. Return the job ID and let the user call `track_progress` later. Do not claim the video exists until the job succeeds and the media-pool asset is returned.

The first implementation is intentionally single-segment. Split a longer narration into ordered audio segments in a later workflow rather than sending audio longer than 15 seconds.
