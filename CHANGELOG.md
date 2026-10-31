# Changelog

## 2.2.0 — 2026-10-30

**Instant raise.** Raising the delay no longer makes viewers wait through a delay screen while the buffer fills. InstantDelay already kept the last minute of the stream for clips; now it rewinds into it.

### Added
- **Rewind on raise** (`raiseMode: "rewind"`, the new default): going from 0 to 30 s sends the last 30 s again, so the new delay applies the moment you press the button and viewers see a replay of those seconds, then the stream carries on 30 s behind live. No pause, no screen, no "building" bar. Starts on the keyframe at or before the mark (up to one GOP more replay); timestamps stay continuous; nothing is skipped.
- `rewindSec` (default 60): how far back a rewind can reach. The replay window is shared with clips (`max(clipSec, rewindSec)` is kept). A raise bigger than the window shows the delay screen for the difference first, then the replay.
- `raiseMode: "screen"` keeps the 2.1 behaviour (delay screen while the buffer fills).
- Dock: *When the delay goes up* setting; a blue **Replay · N s** tag on the readout while viewers watch the rewound seconds. Overlay shows `DELAY 30s · REPLAY` meanwhile. Log line and `rewind` engine event.
- Status: `rewinding`, `rewindMs` (replay time left), `rewinds`, `raiseMode`, `rewindSec`.

### Changed
- The delay screen is now mainly for cuts and OBS dropouts; the settings section is titled accordingly.
- `clipAvailableMs` is capped at `clipSec + delay` even when the replay window is larger.

## 2.1.0 — 2026-10-26

**The delay screen.** Raising the delay no longer freezes the stream (and no longer makes Twitch drop it after ~30 s): viewers see a picture while the buffer fills.

### Added
- **Delay screen**: while the output would pause (delay raised, cut hole, OBS gone) InstantDelay sends a still picture + silence instead. Built-in *"Stream delay is building"* screen, or your own PNG (upload in ⚙ Settings; letterboxed, never stretched). `delayScreen` setting: `default` / `<file>.png` / `freeze` / `off`. A **Preview to viewers** button shows it for 5 s so you can check it on your channel.
  - Done with a tiny built-in H.264 encoder (`src/h264.js`): intra-only picture using the stream's own SPS plus one extra CAVLC PPS, then ~10-byte skip frames at 10 fps and a keyframe every 2 s. About 20 KB per keyframe at 1080p, encoded once per stream in ~150 ms. Bit-exact against ffmpeg's decoder in the tests. AAC silence frames keep the audio track alive. Streams the encoder can't draw for (HEVC/AV1, 10-bit, interlaced) fall back to repeating the last keyframe.
  - The stream resumes on OBS's next keyframe; pauses under 1.5 s get no screen.
- **Save a clip**: `GET /api/clip?sec=N` and dock buttons write the last N seconds of what OBS sent to `clips/<timestamp>.flv`, no re-encoding (`clipSec` keeps a replay window, default 60 s).
- **Record the broadcast**: `recordDir` writes one `.flv` per output session, exactly what the ingest received.
- **OBS scene rules**: `obsWsUrl` / `obsWsPassword` / `sceneDelays` — the delay follows the OBS scene via obs-websocket v5 (Node.js 22+). The dock can fill in your scene list.
- **Backup ingest** (`outputUrlBackup`): used after two failed connections to the main one.
- **Twitch bandwidth test mode** (`bandwidthTest`): stream to Twitch without going live, for testing.
- **Alerts** (`webhookUrl`): Discord / Slack / generic JSON webhook on output dropped or back, OBS gone or back, delay changed, OBS bitrate collapse, clip saved.
- Dock: *Delay screen* tag and amber OUT lamp while viewers see the screen; clip buttons; OBS scene and recording in the stats row. Overlay shows `DELAY · SCREEN` meanwhile.
- Status: `holding`, `holdKind`, `holdMs`, `holds`, `holdTags`, `screen`, `obs`, `recording`, `clipAvailableMs`, `outputTarget`.

### Changed
- `cut` no longer freezes the output when it reaches the hole: viewers see the delay screen for that long.

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
