# InstaDelay v1

**Change your stream delay mid-stream without restarting OBS.**

OBS streams to this app on your own PC. The app holds the video in a buffer and forwards it to Twitch with whatever delay you pick. You can change the delay at any time from an OBS dock, a Stream Deck button or a web link.

```
OBS ──RTMP──▶ InstantDelay (your PC, holds the buffer) ──RTMP──▶ Twitch
                     ▲
     OBS dock / overlay / Stream Deck
```

- **Lowering the delay** (for example "⚡ INSTANT") skips forward. Viewers see a clean cut back to live.
- **Raising the delay** pauses the stream for viewers while the buffer fills (e.g. going 0 → 30s = a 30s freeze). Tip: switch to a BRB scene first.
- Video and audio are never re-encoded, so CPU use is close to zero.

## Setup on Windows 11 (about 5 minutes)

1. **Unzip** this folder somewhere permanent, e.g. `Documents\InstantDelay`.
2. **Double-click `start.bat`.**
   - The first time, it installs **Node.js** and **ffmpeg** for you (via `winget`, built into Windows 11). Say *Yes* if Windows asks for permission.
   - Then it asks for your **Twitch stream key**: [dashboard.twitch.tv](https://dashboard.twitch.tv) → Settings → Stream → *Primary Stream key* → Copy. Right-click pastes it into the window. The key stays hidden while you type.
   - If an install step says it finished but InstantDelay still can't find Node.js or ffmpeg, close the window and double-click `start.bat` again.
3. **Point OBS at InstantDelay** (one-time): OBS → **Settings → Stream**
   - Service: **Custom…**
   - Server: `rtmp://127.0.0.1:1935/live`
   - Stream Key: `stream`
   - Leave *Use authentication* off.
4. **Recommended OBS settings:**
   - **Settings → Output → Keyframe Interval: `2`** (Twitch wants this anyway; it makes delay jumps clean).
   - **Settings → Advanced → Stream Delay: off.** InstantDelay does the delay now.
5. **Add the control dock:** OBS → **Docks → Custom Browser Docks…** → Name `InstantDelay`, URL `http://127.0.0.1:8787/dock`.

**Every stream from now on:** double-click `start.bat`, then click *Start Streaming* in OBS as usual. Leave the black InstantDelay window open while you stream (minimizing is fine). When you stop streaming, the Twitch stream ends after the buffer has played out (plus 30 seconds, in case OBS is just reconnecting).

To change the stream key later, double-click `change-stream-key.bat`.

![dock](docs/dock.png)

### Optional: on-stream badge

Add a **Browser Source** with URL `http://127.0.0.1:8787/overlay` to show a LIVE / DELAY badge on stream. Use `http://127.0.0.1:8787/overlay?hideLive=1` to only show it while there is a delay.

### Optional: Stream Deck buttons

Use Stream Deck's built-in **System → Website** action and tick **"GET request in background"**:

| URL | What it does |
|---|---|
| `http://127.0.0.1:8787/api/instant` | Delay 0, jump to live |
| `http://127.0.0.1:8787/api/delay?sec=30` | Set delay to 30s |
| `http://127.0.0.1:8787/api/delay?add=5` / `add=-5` | Nudge the delay |
| `http://127.0.0.1:8787/api/toggle?sec=30` | Toggle between live and 30s |
| `http://127.0.0.1:8787/api/status` | Status (JSON) |

Invalid values (e.g. `sec=3o`) are rejected and leave the delay unchanged.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dock shows **"InstantDelay is not running"** | Start `start.bat`. The dock reconnects by itself. |
| Dock shows **"No stream key"** | Run `change-stream-key.bat`, then restart `start.bat`. |
| **OBS ○** stays red after Start Streaming | Check OBS → Settings → Stream matches step 3 exactly. |
| **OUTPUT ○** stays red | Wrong stream key or no internet. Read the InstantDelay window. It retries automatically. |
| "port … is already in use" | InstantDelay is probably already open in another window. Close it. |
| "ffmpeg was not found" | Close the window and run `start.bat` again (new installs need a fresh window), or run `winget install ffmpeg`. |
| Twitch "Enhanced Broadcasting" | Not available with a Custom server. Turn it off. |

The stream key is never printed in the window (it shows as `****`), but it is stored in plain text in `config.json`. Don't share that file.

## Settings (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `outputUrl` | — | Where to send the stream. Set by the setup. Any `rtmp://`/`rtmps://` URL works (Twitch, YouTube, Kick…). Default Twitch server auto-picks a nearby ingest; to choose one yourself see [Twitch's ingest list](https://help.twitch.tv/s/twitch-ingest-recommendation). |
| `presetsSec` | `[0,5,15,30,60,120]` | Buttons in the dock. |
| `maxDelaySec` | `300` | Largest delay allowed. |
| `initialDelaySec` | `0` | Delay when the app starts. |
| `endAfterIdleSec` | `30` | End the Twitch stream this long after OBS stops (0 = keep the connection open). |
| `rtmpHost` | `127.0.0.1` | Set to `0.0.0.0` for a two-PC setup where OBS runs on another computer (Windows Firewall will ask). |
| `rtmpPort` / `httpPort` | `1935` / `8787` | Ports for OBS and for the dock/API. |
| `ffmpegPath` | `ffmpeg` | Full path to ffmpeg if it isn't found automatically (use forward slashes: `C:/ffmpeg/bin/ffmpeg.exe`). |

Restart InstantDelay after editing.

## Known limits

- Raising the delay freezes the stream for viewers while the buffer fills. Increases of more than about 20–30s could make Twitch drop the connection (untested). If that happens InstantDelay reconnects by itself.
- If OBS stops and starts streaming again within `endAfterIdleSec`, the app keeps one continuous Twitch session. Changing encoder settings in between isn't handled.
- The dock/API only listens on this PC (127.0.0.1). It has no password, but requests from other websites are blocked, so a web page can't change your delay.
- Memory use is the bitrate × the delay (for example, 6 Mbps × 60s ≈ 45 MB).

## For developers

Requires Node.js 18+ and ffmpeg. No npm packages.

```bash
cp config.example.json config.json   # or: node src/setup.js
npm start
npm test        # unit tests for the delay engine + an end-to-end run
```

The end-to-end test runs a fake OBS (an ffmpeg test pattern) through the proxy into a file. It changes the delay 0 → 5s → 0 → 3s, checks that the API rejects bad input and cross-site requests, stops "OBS" and checks that the output was ended cleanly, stays continuous, and decodes without errors. It skips itself when ffmpeg/ffprobe aren't installed.

```
OBS ──RTMP──▶ ffmpeg (listen :1935) ──FLV──▶ DelayEngine (buffer) ──FLV──▶ ffmpeg ──RTMP──▶ Twitch
                                                   ▲
                       OBS dock / overlay / Stream Deck  ──HTTP :8787──┘
```

## Roadmap: from v1 to a real product

1. **v1 (this):** Node proxy + ffmpeg, browser dock, overlay, HTTP API for Stream Deck, auto-reconnect with backoff, one-click Windows launcher.
2. **v1.5, smoother delay changes:** a "ramp" mode that grows the delay slowly instead of freezing. This needs a timestamp stretch on video plus re-encoding the audio (time-stretch), or a slate/BRB clip inserted while the buffer fills. Stream-key storage in the OS keychain.
3. **v2, drop the ffmpeg dependency:** implement RTMP ingest and publish natively, for example with Rust (`rml_rtmp`) or Go (`yutopp/go-rtmp`), and ship one binary.
4. **v2.5, desktop app:** wrap it in Tauri or Electron with a tray icon, an installer, an auto-updater (`latest.json`), and settings and preset editors.
5. **v3, a real OBS plugin (C++, built with the obs-plugintemplate):**
   - Option A: a custom **output/service** plugin. The plugin takes encoded packets from OBS's `obs_output` API, keeps its own delay queue (OBS's built-in delay in `libobs/obs-output-delay.c` is the reference), and publishes straight to RTMP. No proxy and no second process.
   - Option B: a small plugin that adds a Qt dock and hotkeys, and talks to the proxy above.
   - Built with CMake + Qt6 against libobs for Windows, macOS and Linux, then signed and packaged.
6. **Stream Deck plugin:** the Elgato SDK (Node/TypeScript) with live key titles that show the current delay, connected through the WebSocket/SSE status feed.
