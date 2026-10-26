# Contributing

Thanks for helping. The project is small on purpose: one Node.js process, no npm dependencies, no build step.

## Dev setup

```bash
git clone https://github.com/Elsrdorito/instantdelay && cd instantdelay
cp config.example.json config.json      # or: npm run setup
npm start                               # http://127.0.0.1:8787/dock
npm test                                # unit + protocol + end-to-end (e2e needs ffmpeg + ffprobe on PATH)
```

The e2e tests use ffmpeg as a fake OBS and a fake ingest. On macOS: `brew install ffmpeg`; Windows: `winget install ffmpeg`; Ubuntu: `apt install ffmpeg`.

## Layout

| Path | What |
|---|---|
| `src/server.js` | Orchestrator: input → engine → output, reconnects, HTTP API, SSE |
| `src/delay.js` | The delay engine (pure, clock-injected, unit-tested) |
| `src/rtmp/` | Native RTMP: AMF0, chunk stream, handshake, ingest server, publish client |
| `src/transports/ffmpeg.js` | Fallback transport that shells out to ffmpeg |
| `src/flv.js`, `src/flv-file.js` | FLV tag parsing/encoding, file output |
| `src/config.js`, `src/log.js` | Config load/validate/save; redacting ring-buffer logger |
| `public/` | Dock and overlay: single HTML files, no framework |
| `test/` | `delay.test.js`, `rtmp-unit.test.js` (fast), `rtmp-e2e.js`, `e2e.js` (ffmpeg) |

See `docs/ARCHITECTURE.md` for how the pieces fit, and `docs/IDEAS.md` for what we'd like to build next.

## Rules of thumb

- **Keep zero runtime dependencies.** A streamer should be able to unzip and double-click.
- **Never log or expose the stream key.** `log()` redacts it; status/config endpoints use the masked form.
- **The engine stays pure.** `src/delay.js` must not touch sockets, timers (other than its own `start()`), or the filesystem, so it stays testable with a fake clock.
- **Add a test** for engine or protocol changes. `npm run test:unit` must stay under a second.
- **Don't break the API.** Stream Deck users have the URLs in `README.md` saved; add new routes rather than changing existing ones.
- Two-space indent, single quotes, semicolons (see `.editorconfig`). No linter is enforced; `npm run lint` only syntax-checks.

## Pull requests

1. One topic per PR, with a line in `CHANGELOG.md` under *Unreleased*.
2. Run `npm test` (at least `npm run test:unit` if you can't install ffmpeg).
3. If you changed the dock, attach a screenshot at ~320 px wide (OBS dock size).
