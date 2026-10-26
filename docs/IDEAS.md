# Ideas and roadmap

What InstantDelay could become, ranked by how much streamers would feel it versus how hard it is. Everything here keeps the two promises: **no re-encoding** and **no runtime dependencies**. Pick one, open an issue, build it.

Legend: 🟢 small (a day) · 🟡 medium (a week) · 🔴 big (weeks) · ⚠️ needs real-world testing first

## Next up (v2.1 – v2.3)

### 1. Auto-BRB when raising the delay 🟡
The one real wart of a delay proxy: raising the delay freezes the *last frame* for viewers. If that frame is gameplay, it looks like the stream died. OBS 28+ ships **obs-websocket v5** (WebSocket + SHA-256 auth, both built into Node 22). InstantDelay can: switch OBS to a chosen "BRB" scene → wait until that scene has reached the output (current delay + 1 s) → raise the delay (viewers now stare at a nice BRB card) → switch back once the buffer is full. One checkbox in Settings: *"Switch to scene ___ while the delay builds."* Needs the obs-websocket password once.

### 2. Scene-based delay rules 🟢 (after #1)
Same WebSocket. "When the scene is *Gameplay* → 30 s. *Just Chatting* → live. *Queue/Loading* → 60 s." Streamers already switch scenes; the delay follows for free. Rules live in `config.json`, editable in the dock.

### 3. "Viewer's eye" preview page 🟡
`/preview` plays the **delayed** output in the browser so the streamer can see exactly what viewers see right now, without opening Twitch (which adds its own 2–10 s). Needs an FLV → fragmented-MP4 remux in JS (`ftyp`/`moov` with `avcC`/`esds`, then `moof`/`mdat` per keyframe group, ~300 lines) feeding Media Source Extensions. Also useful as an OBS dock. H.264/AAC only; HEVC/AV1 later.

### 4. Save a clip from the buffer 🟢
The buffer already holds the last N seconds, encoded. "Save last 60 s" writes `clips/2026-10-25_20-14.flv` with zero extra CPU (and `.mp4` once #3's remuxer exists). It's OBS's Replay Buffer for people who don't want to run two encoders. Stream Deck: `/api/clip?sec=60`.

### 5. Record the delayed output 🟢
`recordTo: "recordings/"` tees every tag that goes to the ingest into a local `.flv`. A local VOD that matches what was broadcast, cuts included.

### 6. Keep the ingest alive while the delay builds ⚠️🟡
During a fill, nothing is sent. How long Twitch/YouTube/Kick tolerate silence before dropping the connection is undocumented; we need numbers (issue #?). If it matters, send filler: AAC silence frames are a known constant per sample rate/channel layout; for video, repeat the last keyframe with advancing timestamps (small visual jump back ≤ 2 s) or synthesize H.264 "all-skip" P-frames (trivial for CAVLC, needs a CABAC encoder for the x264/NVENC default). The player's clock keeps advancing and the freeze becomes a hold.

### 7. Slow-motion ramp 🟡
Instead of freezing, play video at 50 % speed for 60 s to gain 30 s of delay: only timestamps change (`ts' = base + (ts − base) × 2`), no re-encoding. Audio can't be stretched without decoding, so it's replaced with AAC silence for the ramp. Looks great on a BRB/scoreboard scene, odd on gameplay; pair with #1.

### 8. Backup ingest 🟢
`outputUrlBackup`: after N failed connects to the primary, try the backup (Twitch publishes a backup ingest; YouTube gives two URLs per stream). Report which one is in use.

### 9. Twitch stream markers on jump/cut 🟢
Call Helix `POST /streams/markers` whenever the delay jumps or a cut happens, so the VOD editor can find the spots. Needs a user token with `channel:manage:broadcast`; store it like the stream key.

### 10. Alerts 🟢
Webhook (Discord/Telegram/generic URL) on: output dropped, OBS gone, backlog growing, delay changed. Fire-and-forget `fetch`.

## Bigger bets

### 11. Multi-output with per-destination delay 🔴
One buffer, several read heads: Twitch at 30 s, Kick live, a local recording at 0. Memory stays bitrate × longest delay. The engine's cursor logic (keyframe alignment, generations, timeline rewriting) becomes per-output; `setDelay`, `cut` and status take an output id. This is the "restream, but with delay" product.

### 12. Stream Deck plugin 🟡
Elgato SDK (TypeScript). Keys show the live delay (from `/api/events`), long-press to cut, a dial on the Stream Deck + to nudge. The built-in "Website" action works today but can't display state.

### 13. Tray app + installer 🟡
Keep the Node core; add a tray icon (start/stop, open dock, "live"/"delayed" icon state) and a proper installer with auto-update. Options: Node single-executable (`node --experimental-sea`) + a small Rust/C# tray, or Tauri wrapping the dock. `winget` manifest and a Homebrew tap once there's a signed binary.

### 14. Native OBS plugin 🔴
A C++/Qt plugin that adds a real dock, OBS hotkeys (global, no focus needed) and talks to the proxy. Or go all the way: an *output* plugin that takes encoded packets from `obs_output` and runs the delay queue in-process (OBS's `obs-output-delay.c` is the reference), no proxy at all. Big, platform-specific, but the best possible UX.

### 15. Two-PC and NAS mode 🟡
Already possible (`rtmpHost: 0.0.0.0`). Make it good: a Docker image, a systemd unit, a token for the API so a phone can be the remote (`/dock` is already responsive), mDNS so OBS can use `rtmp://instantdelay.local`.

### 16. SRT in/out 🔴
OBS can send SRT; some ingests accept it (lower latency, better loss recovery than RTMP). SRT is a sizeable protocol (handshake, ARQ, encryption). Only worth it if users ask.

## Small polish

- Session log in the dock: every delay change, cut and reconnect with timestamps; export as text (🟢).
- Bitrate sparkline for the last 2 minutes; warn when input bitrate collapses (🟢).
- Localize the dock: a 40-string table, `?lang=` or browser language (🟢).
- High-contrast / light theme for bright rooms (🟢).
- `?bandwidthtest=true` toggle for Twitch's bandwidth test mode (🟢).
- Enhanced-RTMP (HEVC/AV1) verification against a real ingest, then say so in the README (⚠️🟢).
- Tests against real OBS and real Twitch in CI are impossible, but a nightly job could run OBS headless in a VM with a test key (⚠️🟡).

## Considered and rejected (for now)

- **Re-encoding to smooth ramps or insert slates.** Doubles CPU and quality loss; the whole point is passthrough. Use #1/#7 instead.
- **Global hotkeys inside InstantDelay.** Needs a native module (no deps rule) or Electron. Stream Deck, OBS hotkeys via #14, or the obs-websocket trick (toggle a dummy source's visibility with an OBS hotkey; InstantDelay watches the event) cover it.
- **A password on the local API by default.** Hurts the double-click experience; the Host/Sec-Fetch-Site guards already stop web pages. Add a token only for the LAN mode (#15).
- **Storing the stream key in the OS keychain.** Nice, but needs a native dependency on every platform; OBS itself stores it in plain text.
- **npm dependencies "just for X".** Every one of them is an install step for a streamer. The project should stay unzip-and-run.
