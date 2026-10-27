# Ideas and roadmap

What InstantDelay could become, ranked by how much streamers would feel it versus how hard it is. Everything here keeps the two promises: **no re-encoding** and **no runtime dependencies**. Pick one, open an issue, build it.

Legend: 🟢 small (a day) · 🟡 medium (a week) · 🔴 big (weeks) · ⚠️ needs real-world testing first

## Shipped in 2.1 (2026-10-26)

The real-world number came in: **Twitch drops a publisher after ~30 s without data**, so every delay raise above 30 s killed the stream. That turned "keep the ingest alive" from a maybe into the headline feature, and changed the plan: a *delay screen* drawn by InstantDelay itself beats switching OBS to a BRB scene (the BRB frames would only reach viewers after the fill anyway).

- **Delay screen / keep-alive** (was #6): a ~600-line intra-only H.264 encoder (`src/h264.js`) draws the screen with the stream's own SPS + an extra CAVLC PPS, then 10-byte skip frames and a keyframe every 2 s; AAC silence for audio. Bit-exact against ffmpeg. Custom PNG upload, preview-to-viewers button, `freeze`/`off` modes.
- **Scene-based delay rules** (was #2) via obs-websocket v5 (`src/obsws.js`, Node 22+).
- **Save a clip** (#4), **record the output** (#5), **backup ingest** (#8), **alerts** (#10, incl. an OBS-bitrate-collapse alert), **Twitch bandwidth-test mode**.
- Auto-BRB (#1) is no longer needed for fills. It could still be useful as "switch OBS to scene X when the delay changes", which is what scene rules do in reverse; dropped for now.

## Next up

### 1. Countdown on the delay screen 🟢
The encoder is fast enough (~150 ms at 1080p, far less for a small region) to re-draw the screen once per second with *"back in 42 s"*. Needs a small bitmap font (digits + a few letters) composited onto the picture before encoding, and re-encoding only every second instead of once per stream. Also "viewers see this for N more seconds" in the dock.

### 2. "Viewer's eye" preview page 🟡
`/preview` plays the **delayed** output in the browser so the streamer can see exactly what viewers see right now, without opening Twitch (which adds its own 2–10 s). Needs an FLV → fragmented-MP4 remux in JS (`ftyp`/`moov` with `avcC`/`esds`, then `moof`/`mdat` per keyframe group, ~300 lines) feeding Media Source Extensions. Also useful as an OBS dock. H.264/AAC only; HEVC/AV1 later. The same remuxer gives **`.mp4` clips** instead of `.flv`.

### 3. Delay screen per reason 🟢
Different pictures for "delay building", "cut" and "OBS is gone (technical difficulties)". The engine already knows why it is holding; `delayScreen` becomes `{ fill, cut, lost }` with the single-string form kept as a shortcut.

### 4. Slow-motion ramp 🟡
Instead of a screen, play video at 50 % speed for 60 s to gain 30 s of delay: only timestamps change (`ts' = base + (ts − base) × 2`), no re-encoding. Audio can't be stretched without decoding, so it's replaced with AAC silence for the ramp. Looks great on a BRB/scoreboard scene, odd on gameplay.

### 5. Twitch stream markers on jump/cut 🟢
Call Helix `POST /streams/markers` whenever the delay jumps or a cut happens, so the VOD editor can find the spots. Needs a user token with `channel:manage:broadcast`; store it like the stream key.

### 6. Scene rules, the other way round 🟢
obs-websocket is connected now: show the current delay in an OBS text source, or flash a source while viewers see the delay screen, so the streamer sees state without the dock.

### 7. HEVC/AV1 delay screen 🟡
Today those streams fall back to repeating the last keyframe. An all-intra HEVC picture is a bigger job (CABAC only); AV1 has no CAVLC-like escape hatch either. Probably "wait until Twitch takes HEVC widely".

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

- **Re-encoding the stream to smooth ramps or insert slates.** Doubles CPU and quality loss; the whole point is passthrough. The delay screen is the one still picture we encode ourselves, once per stream; the slow-motion ramp (#4) is the other option.
- **Global hotkeys inside InstantDelay.** Needs a native module (no deps rule) or Electron. Stream Deck, OBS hotkeys via #14, or the obs-websocket trick (toggle a dummy source's visibility with an OBS hotkey; InstantDelay watches the event) cover it.
- **A password on the local API by default.** Hurts the double-click experience; the Host/Sec-Fetch-Site guards already stop web pages. Add a token only for the LAN mode (#15).
- **Storing the stream key in the OS keychain.** Nice, but needs a native dependency on every platform; OBS itself stores it in plain text.
- **npm dependencies "just for X".** Every one of them is an install step for a streamer. The project should stay unzip-and-run.
