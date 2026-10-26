'use strict';
// RTMP handshake (simple version, no digest). OBS's librtmp and ffmpeg both
// fall back to this when the peer answers with a zero version, and public
// ingests (Twitch, YouTube, Kick...) accept it from publishers.
const crypto = require('crypto');

const SIZE = 1536;

function c1() {
  const b = crypto.randomBytes(SIZE);
  b.writeUInt32BE(0, 0); // time
  b.writeUInt32BE(0, 4); // version 0 = simple handshake
  return b;
}

// Returns a function fed with socket data; resolves `done()` once complete with
// any bytes received past the handshake.
//   role: 'server' expects C0C1 -> sends S0S1S2 -> expects C2
//   role: 'client' sends C0C1 -> expects S0S1S2 -> sends C2
function handshake(socket, role, done) {
  let buf = Buffer.alloc(0);
  let stage = 0;
  let finished = false;
  if (role === 'client') socket.write(Buffer.concat([Buffer.from([3]), c1()]));
  const need = role === 'server' ? [1 + SIZE, SIZE] : [1 + SIZE + SIZE];

  return function feed(data) {
    if (finished) return done(null, data);
    buf = buf.length ? Buffer.concat([buf, data]) : data;
    while (!finished && buf.length >= need[stage]) {
      if (role === 'server') {
        if (stage === 0) {
          if (buf[0] !== 3 && buf[0] !== 6) return done(new Error(`unsupported RTMP version ${buf[0]}`));
          const peerC1 = buf.subarray(1, 1 + SIZE);
          const s1 = c1();
          // S2 echoes C1 (time2 = our time, 0). Clients ignore the rest.
          const s2 = Buffer.from(peerC1);
          s2.writeUInt32BE(0, 4);
          socket.write(Buffer.concat([Buffer.from([3]), s1, s2]));
          buf = buf.subarray(1 + SIZE);
          stage = 1;
        } else {
          buf = buf.subarray(SIZE); // C2: not verified (simple handshake)
          finished = true;
        }
      } else {
        if (buf[0] !== 3) return done(new Error(`unsupported RTMP version ${buf[0]}`));
        const s1 = buf.subarray(1, 1 + SIZE);
        const c2 = Buffer.from(s1);
        c2.writeUInt32BE(0, 4);
        socket.write(c2);
        buf = buf.subarray(1 + SIZE + SIZE);
        finished = true;
      }
    }
    if (finished) { const rest = buf; buf = Buffer.alloc(0); done(null, rest); }
  };
}

module.exports = { handshake };
