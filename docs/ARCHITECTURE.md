# Architecture

```
            RTMP (TCP 1935)                      tags                        tags                  RTMP/RTMPS
 OBS ───────────────────────▶ RtmpIngest ───────────────▶ DelayEngine ───────────────▶ RtmpPublisher ────────────▶ Twitch
                             src/rtmp/ingest.js          src/delay.js                 src/rtmp/publish.js
                                                              ▲ setDelay / cut
                                                              │
      dock / overlay / Stream Deck ───── HTTP + SSE (127.0.0.1:8787) ───── src/server.js
```

One Node.js process, no dependencies. `src/server.js` wires the pieces together and owns all policy (reconnects, backoff, idle end, config); the pieces themselves are small and dumb.

## The unit of work: an FLV tag

Everything between ingest and publish is an FLV tag: `{ type (8 audio / 9 video / 18 script), ts (ms), data (Buffer), isKey, isSeq, cts }`. RTMP audio/video/data messages map 1:1 onto FLV tags (RTMP's message body *is* the FLV tag body), so the proxy never parses codecs. `src/flv.js` only looks at the first bytes to find keyframes, sequence headers (SPS/PPS, AAC config, onMetaData) and the composition-time offset for B-frames. Enhanced-RTMP (HEVC/AV1) headers are recognized too.

## DelayEngine (`src/delay.js`)

A wall-clock buffer. Each tag is stamped with its arrival time; it is released once `recv + delayMs <= now`. The engine is driven entirely by `now` so the unit tests run it with a fake clock in milliseconds.

- **Buffer** is a deque (array + head index): O(1) push/shift. 300 s of audio+video is ~25k tags; `Array.shift` would move all of them per released tag.
- **Timing**: `start()` arms one `setTimeout` for the next due tag. No polling; nothing runs while the buffer is empty.
- **Lowering the delay** (`setDelay` to a smaller value): drop buffered tags up to the latest keyframe that is already due under the new delay, so the output continues on a keyframe. Audio before that keyframe is dropped too. Codec-config tags are never dropped.
- **Raising the delay**: nothing real is released until the buffer holds `delayMs`; the *hold* (below) fills the gap for viewers.
- **Cut** (`cut(ms)`): truncate the newest `ms` from the tail and bump the *generation*. Every tag carries the generation it was received in; when the output crosses a generation boundary it waits for a keyframe and re-bases timestamps. The same mechanism handles any future "hole" we might create.
- **Output timeline**: timestamps are rewritten so the published stream is one continuous, monotonic timeline across delay changes, cuts, OBS reconnects (input timestamps restart at 0) and output reconnects. `_offsetAfterSent` places the next keyframe after the last *displayed* frame (`lastVideoPts`, which accounts for B-frame reordering), not just the last decoded one; this was a real bug in v1.
- **Codec headers**: the engine remembers the latest sequence headers *as they pass the output position*, so an output reconnect replays the config that matches the content being sent, even if OBS changed encoders while older content was still buffered.
- **Stats**: in/out bytes and tags, dropped tags, buffered bytes, 1-second bitrates.
- **Hold** (the keep-alive): whenever the next real tag is ≥ 1.5 s away (fill, cut hole) or nothing has gone out for 1 s with an empty buffer (OBS gone), the engine asks its `holdSource` for a session and emits its tags on a timer: video every 100 ms, audio every AAC frame (21.3 ms at 48 kHz). Timestamps continue from the last real frame (`lastOutAny`/`lastVideoPts`), so the resume is seamless. A hold ends when the next real keyframe is due: `needKeyframe` and `headersSent` were reset at hold start, so the real stream re-sends its own codec headers and restarts on a keyframe (≤ one GOP of content is skipped). `previewHold(ms)` forces a hold and skips due content meanwhile, so the streamer can rehearse the screen. Only the server knows whether an output is connected; it toggles `engine.keepAlive`.
- **Replay window** (`replayMs`): tags that left the buffer are kept this long so `clip(ms)` can return the last N seconds (replay + buffer) starting on a keyframe with headers first and timestamps from 0.

## The delay screen (`src/filler.js`, `src/h264.js`, `src/screen.js`, `src/png.js`)

The hold source. Twitch drops a publisher after ~30 s without data, so pausing is not an option; and the "no re-encoding" rule still stands for the stream itself. The trick: the picture is encoded **as part of the running stream**.

- `h264.js` parses the stream's SPS out of the AVC sequence header OBS sent, and writes one extra **PPS** (CAVLC, deblocking on, a free `pps_id`) that refers to that SPS. Our pictures use that PPS; OBS's frames keep using theirs. We never have to match CABAC, 8x8 transforms or B-frame settings. The new sequence header (avcC with both PPS) goes out before the first picture; the PPS is also sent in-band inside the IDR access unit, for ingests that ignore repeated sequence headers.
- The **IDR picture** is Intra_16x16 only (V/H/DC/plane prediction chosen by SAD), 4x4 integer transform, the standard quantizer (QP 22), luma-DC Hadamard, chroma DC 2x2, CAVLC residuals with the standard VLC tables. Macroblocks whose levels would not fit the `level_prefix 15` escape are written as I_PCM (lossless, 384 bytes) instead. The reconstruction loop mirrors the decoder exactly; the tests compare it byte for byte against ffmpeg with deblocking off.
- Between keyframes, **P pictures with `mb_skip_run = all`** (~10 bytes) repeat the picture at 10 fps; an IDR every 2 s keeps Twitch's keyframe rule. `frame_num`/POC follow the SPS (POC types 0 and 2 are supported; 1 is not used by any OBS encoder).
- Supported: 4:2:0, 8-bit, progressive, no custom scaling matrices (everything OBS sends to Twitch). Otherwise `HoldSource` falls back to repeating the last real keyframe.
- Audio: fixed AAC-LC silence frames (mono/stereo), sample-rate independent; the FLV audio header byte is copied from the stream's own sequence header.
- `screen.js` letterboxes the PNG into the visible area (never stretched; bars take the average edge colour), replicates edges into the cropped margin, converts to limited-range BT.709 (≥ 720 lines) or BT.601. `png.js` decodes any non-interlaced PNG with Node's zlib.
- Cost: ~20 KB per keyframe at 1080p for the built-in screen (≈ 90 kb/s while shown), ~150 ms to encode, once per stream (cached per sequence header).

## RTMP (`src/rtmp/`)

Just enough of the protocol to be a publisher's server and an ingest's client.

- `handshake.js`: the simple (non-digest) handshake. OBS's librtmp falls back to it when the server answers with version 0; public ingests accept it from publishers.
- `chunk.js`: `ChunkReader` reassembles messages from chunks (fmt 0–3, 1/2/3-byte csids, extended timestamps repeated on continuation chunks the way ffmpeg/librtmp do it, peer chunk-size changes). It parses a chunk header into locals and only commits state when the whole chunk is present, so partial reads can't double-apply a timestamp delta. `ChunkWriter` emits fmt 0 for the first message on a chunk stream and fmt 1 afterwards (fmt 0 again if time goes backwards or the stream id changes).
- `amf0.js`: AMF0 encode/decode for commands and `onMetaData`.
- `ingest.js`: `net.Server`. Answers `connect` (window ack size, peer bandwidth, stream begin, chunk size 4096, `_result`), `createStream`, `releaseStream`/`FCPublish`, `publish` (optionally checks the stream key; a new publisher replaces the old one, which is what you want after an OBS crash), pings, acknowledgements. Media messages become tags; `@setDataFrame` is stripped from data messages so `onMetaData` looks like an FLV script tag.
- `publish.js`: `net`/`tls` client. `connect` → `releaseStream`, `FCPublish`, `createStream` → `publish` → waits for `onStatus NetStream.Publish.Start`, which is what the orchestrator uses as "connected". Answers pings, sends acks, re-adds `@setDataFrame` to `onMetaData`. `end()` sends `FCUnpublish` + `deleteStream` so the platform ends the broadcast right away.

### Why not keep ffmpeg?

v1 ran two ffmpeg processes (`-listen 1` to receive, `-f flv -i pipe:0` to send). It worked, but: a 100 MB install step on Windows, each OBS reconnect respawned a process, ffmpeg probes the input before writing anything (~1 s extra latency), "connected" had to be inferred from progress lines, and errors came as free text. The native path is ~700 lines, starts instantly and reports real protocol states. The ffmpeg path is kept as `transport: "ffmpeg"` (`src/transports/ffmpeg.js`) as a fallback in case an ingest turns out to dislike our handshake.

## Orchestrator (`src/server.js`)

- **Input**: one ingest for the life of the process. `publish`/`unpublish` events toggle `inputConnected`; tags go straight into the engine.
- **Output**: created lazily when there is something to send and a URL is configured. Sinks share one interface: `connect()`, `send(tag)`, `end()`, `destroy()`, `backlog`, events `ready` (accepts tags), `connected` (ingest confirmed), `error`, `close`. On `ready` the engine is told to restart the output (headers + keyframe). On `close` the orchestrator retries with exponential backoff (1 s … 30 s) unless the close was intentional. If the socket backlog exceeds 64 MB (upload can't keep up) the sink is destroyed and recreated.
- **Idle end**: when OBS has been gone and the buffer is empty for `endAfterIdleSec`, the output is ended cleanly; the next one starts a new session with timestamps at 0.
- **HTTP**: a tiny router; `/api/events` is Server-Sent Events with status every 250 ms. Mutating routes require a loopback `Host` header and a same-origin/none `Sec-Fetch-Site`; `POST /api/config` additionally needs a JSON body ≤ 64 KB. Config changes are validated, written to `config.json`, and applied live where possible (output URL change = clean reconnect).
- **Logging**: `src/log.js` prints to the console and keeps the last 300 lines for the dock; every line passes through a redactor fed with the secret parts of the output URL.

## Tests

- `test/delay.test.js`: engine with a fake clock (continuity, keyframe alignment, B-frame display order, reconnects, cut, header replay, deque).
- `test/hold.test.js`: the hold with a fake hold source: fill, short raise (no hold), cut hole, OBS gone, back to live mid-hold, output restart.
- `test/h264.test.js`: SPS parsing of real x264 headers; bit-exact decode against ffmpeg for Baseline/Main/High, 720p/1080p (with cropping), POC types 0 and 2, deblocking on/off, I_PCM fallback; and a splice of our pictures into a real CABAC/B-frame x264 stream.
- `test/png.test.js`: every colour type/bit depth/filter, via a tiny in-test PNG encoder.
- `test/obsws.test.js`: the obs-websocket client against a fake server (auth, scene events, reconnect). Needs Node 22.
- `test/rtmp-unit.test.js`: AMF0 round trips, chunk reader/writer round trips including extended timestamps and dribbled input.
- `test/rtmp-e2e.js`: ffmpeg publishes into `RtmpIngest`; `RtmpPublisher` publishes into `ffmpeg -listen`; and publisher → ingest directly.
- `test/e2e.js`: the whole server with a fake OBS (ffmpeg test pattern). Changes the delay, cuts, checks the API guards and the settings API, stops "OBS", then verifies the output file is continuous and decodes cleanly. Runs in three modes: file output, RTMP output into `ffmpeg -listen`, and `transport: ffmpeg`.
