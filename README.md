# InstantDelay

**Change your stream delay mid-stream, without restarting OBS.** Jump back to live with one click, cut out the last 30 seconds before viewers see them, and keep it all off the encoder.

OBS streams to InstantDelay on your own PC. InstantDelay holds the encoded video in memory and forwards it to Twitch (or YouTube, Kick, any RTMP ingest) with whatever delay you pick. Change it any time from an OBS dock, a Stream Deck button or a URL.

```
OBS ──RTMP──▶ InstantDelay (your PC, holds the buffer) ──RTMP──▶ Twitch
                       ▲
       OBS dock · overlay · Stream Deck · curl
```

<p align="center"><img src="docs/dock.png" width="300" alt="The InstantDelay dock inside OBS"> <img src="docs/dock-filling.png" width="300" alt="The dock while a 120 s delay builds up"></p>

- **Lowering the delay** (⚡ Instant) skips forward to the next keyframe. Viewers see a clean cut back to live.
- **Raising the delay** pauses the stream for viewers while the buffer fills (0 → 30 s = a 30 s freeze). Switch to a BRB scene first.
- **Cut** throws away the newest N seconds of the buffer, the part viewers haven't seen yet. The delay stays; when the output reaches the hole it pauses that long.
- Video and audio are **never re-encoded**. CPU use is close to zero; memory is bitrate × delay (6 Mbps × 60 s ≈ 45 MB).
- **No dependencies.** One Node.js process that speaks RTMP itself. No ffmpeg, no npm install, no build step.

## Setup on Windows (about 3 minutes)

1. Download the latest zip from **Releases**, unzip it somewhere permanent (e.g. `Documents\InstantDelay`).
2. **Double-click `start.bat`.** The first time it installs Node.js (via `winget`, built into Windows 11; say *Yes* if Windows asks) and asks for your **Twitch stream key**: [dashboard.twitch.tv](https://dashboard.twitch.tv) → Settings → Stream → *Primary Stream key* → Copy. Right-click pastes it; it stays hidden while you type. For YouTube/Kick paste the full `rtmp://…/key` URL instead.
3. **Point OBS at InstantDelay** (one-time): OBS → **Settings → Stream**
   - Service: **Custom…**
   - Server: `rtmp://127.0.0.1:1935/live`
   - Stream Key: `stream`
   - *Use authentication*: off
4. **Recommended OBS settings:**
   - **Settings → Output → Keyframe Interval: 2** (Twitch wants this anyway; it makes delay jumps clean).
   - **Settings → Advanced → Stream Delay: off.** InstantDelay does the delay now.
5. **Add the dock:** OBS → **Docks → Custom Browser Docks…** → Name `InstantDelay`, URL `http://127.0.0.1:8787/dock`.

**Every stream from now on:** double-click `start.bat`, then *Start Streaming* in OBS as usual. Leave the black InstantDelay window open (minimized is fine). When you stop streaming, the Twitch stream ends once the buffer has played out, plus 30 s in case OBS is just reconnecting.

macOS / Linux: install [Node.js 18+](https://nodejs.org) and run `./start.sh`.

### The dock

| | |
|---|---|
| **Readout** | How far behind viewers are *right now*. Amber = delayed, green = live. While a delay builds it shows the progress bar and `output paused`. |
| **OBS / OUT lamps** | Green: data flowing. Blinking amber: connecting. Red: not connected. |
| **⚡ Instant** | Delay 0, jump to live. |
| **Presets / −5 / +5 / custom** | Set the delay. Edit the presets in Settings. |
| **Cut the last…** | Tap once to arm (red), tap again within 3 s to cut. Buttons are disabled when the buffer is shorter than that. |
| **🔒** | Lock the controls against misclicks. |
| **≡ Log** | What the InstantDelay window says, in the dock. |
| **⚙ Settings** | Stream key, presets, limits and advanced options. Saved to `config.json`. |

Keyboard (when the dock has focus): `1`–`9` presets, `0` instant, `Esc` disarm a cut.

### On-stream badge (optional)

Add a **Browser Source** with URL `http://127.0.0.1:8787/overlay` to show a LIVE / DELAY badge on stream.

<img src="docs/overlay.png" width="240" alt="Overlay badge">

Options: `?hideLive=1` only shows it while there is a delay · `?pos=tr` corner (`tl` `tr` `bl` `br`) · `?size=28` font size · `?label=Delay` · `?bare=1` no box.

### Stream Deck (optional)

Use Stream Deck's built-in **System → Website** action and tick **"GET request in background"**:

| URL | What it does |
|---|---|
| `http://127.0.0.1:8787/api/instant` | Delay 0, jump to live |
| `http://127.0.0.1:8787/api/delay?sec=30` | Set delay to 30 s |
| `http://127.0.0.1:8787/api/delay?add=5` / `add=-5` | Nudge the delay |
| `http://127.0.0.1:8787/api/toggle?sec=30` | Toggle between live and 30 s |
| `http://127.0.0.1:8787/api/cut?sec=30` | Cut the last 30 s (no confirmation!) |
| `http://127.0.0.1:8787/api/status` | Status as JSON |

Invalid values (`sec=3o`) are rejected and leave the delay unchanged.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dock says **"InstantDelay is not running"** | Start `start.bat`. The dock reconnects by itself. |
| Dock says **"No stream key yet"** | ⚙ Settings → paste the key → Save. |
| **OBS** lamp stays red after *Start Streaming* | OBS → Settings → Stream must match step 3 exactly. |
| **OUT** lamp stays red / "Retrying in …" | Wrong stream key or no internet. Open ≡ Log for the reason. It retries automatically with backoff. |
| "port … is already in use" | InstantDelay is probably already open in another window. Close it. |
| Twitch "Enhanced Broadcasting" | Not available with a Custom server. Turn it off. |
| Node.js installed but `start.bat` still can't find it | Close the window and double-click `start.bat` again (a new window picks up the new PATH). |

The stream key is never printed (it shows as `****`), but it is stored in plain text in `config.json`. Don't share that file.

## Settings (`config.json`)

Everything here can be edited in the dock (⚙). Keys marked ↻ need a restart.

| Key | Default | Meaning |
|---|---|---|
| `outputUrl` | — | Where to send the stream. Any `rtmp://` or `rtmps://` URL (Twitch, YouTube, Kick…). Default Twitch URL auto-picks a nearby ingest; to choose one yourself see [Twitch's ingest list](https://help.twitch.tv/s/twitch-ingest-recommendation). A file path writes an `.flv` instead. |
| `presetsSec` | `[0,5,15,30,60,120]` | Buttons in the dock. |
| `maxDelaySec` | `300` | Largest delay allowed. |
| `initialDelaySec` | `0` | Delay when the app starts. |
| `endAfterIdleSec` | `30` | End the broadcast this long after OBS stops (0 = keep it open). |
| `rtmpHost` ↻ | `127.0.0.1` | `0.0.0.0` for a two-PC setup where OBS runs on another computer (Windows Firewall will ask). |
| `ingestKey` ↻ | `""` | If set, OBS must use this stream key. Empty = accept any. Set it when using `0.0.0.0`. |
| `rtmpPort` ↻ / `httpPort` ↻ | `1935` / `8787` | Ports for OBS and for the dock/API. |
| `transport` ↻ | `native` | `ffmpeg` uses ffmpeg for RTMP instead of the built-in code (v1 behaviour; needs ffmpeg installed). |
| `ffmpegPath` ↻ | `ffmpeg` | Only for `transport: ffmpeg`. Use forward slashes: `C:/ffmpeg/bin/ffmpeg.exe`. |

Environment variables override the file: `OUTPUT_URL`, `RTMP_PORT`, `HTTP_PORT`, `END_AFTER_IDLE_SEC`, `TRANSPORT`, `INSTANTDELAY_CONFIG` (path of the config file).

## HTTP API

All on `http://127.0.0.1:8787`. Only reachable from this PC; cross-site browser requests are refused.

| Route | |
|---|---|
| `GET /api/status` | Engine + connection status (JSON). Also pushed every 250 ms on `GET /api/events` (Server-Sent Events). |
| `GET /api/delay?sec=N` · `?add=±N` | Set / nudge the delay. |
| `GET /api/instant` | Delay 0. |
| `GET /api/toggle?sec=N` | Live ↔ N seconds. |
| `GET /api/cut?sec=N` | Drop the newest N seconds of the buffer. Returns `removedMs`. |
| `GET /api/config` | Settings without the stream key (`outputMasked`). |
| `POST /api/config` | JSON body with any settings keys, plus `streamKey` (a key or a full URL). Returns `restartRequired: [...]`. |
| `GET /api/log?since=SEQ` | Recent log lines. |

## Known limits

- Raising the delay freezes the stream for viewers while the buffer fills. How long Twitch tolerates a stalled input before dropping the connection is not documented; if it drops, InstantDelay reconnects and continues.
- If OBS stops and restarts within `endAfterIdleSec`, one continuous broadcast is kept. Changing encoder settings in between works (codec headers are re-sent), but some players need a moment to catch up.
- Enhanced RTMP (HEVC/AV1 from OBS 29+) packets are passed through untouched; tested with H.264/AAC.

## For developers

Node.js 18+. No npm packages. ffmpeg + ffprobe are only needed for the end-to-end tests.

```bash
cp config.example.json config.json   # or: npm run setup
npm start
npm run test:unit    # delay engine + RTMP chunk/AMF0 (fast)
npm run test:rtmp    # native ingest/publish against ffmpeg
npm test             # everything, incl. e2e in 3 modes (file output, RTMP output, ffmpeg transport)
```

How it works, in `docs/ARCHITECTURE.md`. What's next, in `docs/IDEAS.md`. Contributions welcome: `CONTRIBUTING.md`.

## License

MIT.
