# Changelog

## 2.0.1 — 2026-10-25

- Windows: the ffmpeg transport now kills the whole ffmpeg process tree (Chocolatey installs a shim that starts the real ffmpeg as a child; killing only the shim left it running and the RTMP port busy).
- CI runs on Windows too (the lint step was a POSIX shell loop).

## 2.0.0 — 2026-10-25

**Native RTMP, no more ffmpeg.** InstantDelay now speaks RTMP itself, on both sides.

### Added
- Native RTMP ingest (what OBS connects to) and publish client (Twitch, YouTube, Kick, any `rtmp://`/`rtmps://` ingest). Only Node.js is needed now; `start.bat` no longer installs ffmpeg.
- **Cut**: `GET /api/cut?sec=N` throws away the newest N seconds of the buffer (what viewers haven't seen yet). The delay stays; the output pauses that long when it reaches the hole. Dock buttons arm on first tap, fire on the second.
- **Settings in the dock**: stream key, presets, max delay, idle end, and advanced options. Saved to `config.json` via `POST /api/config`; most take effect immediately, the rest say "restart needed".
- **Log in the dock** (`GET /api/log`): the last 300 lines of the InstantDelay window, with the key redacted.
- Bitrate in/out, buffer size in MB, a lock button against misclicks, keyboard shortcuts (1–9 presets, 0 instant).
- Overlay options: `?pos=tl|tr|bl|br`, `?size=`, `?label=`, `?bare=1`; blinks while the delay is building.
- `ingestKey` setting to require a specific OBS stream key (recommended with `rtmpHost: 0.0.0.0`).
- `start.sh` for macOS/Linux. CI on Linux/macOS/Windows; release zips.

### Changed
- Delay engine: O(1) buffer (was shifting an array of ~25k tags), releases tags from a single self-arming timer instead of a 5 ms poll, tracks codec headers per output position (an OBS encoder change mid-buffer is replayed correctly after an output reconnect).
- Output reconnect no longer depends on ffmpeg's progress lines; the ingest's `NetStream.Publish.Start` is the signal.
- Config is validated on load and on save; `transport: "ffmpeg"` keeps the old ffmpeg path as a fallback.
- Project renamed consistently to **InstantDelay** (was InstaDelay/InstantDelay in different places).

### Fixed
- Script-data messages other than `onMetaData` (e.g. captions) are no longer treated as codec config.
- Ending the output now sends `FCUnpublish`/`deleteStream` so the platform ends the broadcast immediately.

## 1.0.0 — 2026-10-25

First shareable version: Node proxy around two ffmpeg processes, browser dock, overlay, Stream Deck API, auto-reconnect with backoff, one-click Windows launcher, hardened API (invalid `?sec=` rejected, cross-site/DNS-rebinding blocked, key redacted from logs).
