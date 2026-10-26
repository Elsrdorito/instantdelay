# Security

InstantDelay runs on your own PC and talks to two things: OBS (over RTMP) and your streaming platform's ingest (over RTMP/RTMPS).

## What it protects

- **Your stream key** is stored in `config.json` only (plain text, same as OBS does). It is never printed in the window or sent to the dock; log lines and error messages have it redacted. Don't share `config.json`.
- **The dock/API** (`http://127.0.0.1:8787`) has no password. It only listens on this PC, rejects requests with a foreign `Host` header (DNS rebinding) and rejects cross-site browser requests (`Sec-Fetch-Site`/`Origin`), so a web page you visit cannot change your delay or settings.
- **The RTMP ingest** listens on `127.0.0.1` by default. If you set `rtmpHost` to `0.0.0.0` (two-PC setups), set `ingestKey` so only OBS instances that know it can publish.

## What it does not do

- No TLS on the local HTTP API (it never leaves the machine).
- No authentication beyond the above. Don't expose port 8787 to the internet.

## Reporting a vulnerability

Open a GitHub issue with the label `security`, or if it is sensitive, use GitHub's private vulnerability reporting on the repository. Please include steps to reproduce.
