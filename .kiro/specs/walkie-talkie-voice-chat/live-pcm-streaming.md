# Live PCM Streaming

Supersedes the "Chunk Accumulation Strategy" section of
[audio-empty-data-fix.md](./audio-empty-data-fix.md).

## Problem

Voice replies felt like they took roughly twice as long as they should. A
listener heard nothing at all until the speaker released push-to-talk, so a
five second message took five seconds to say and then started playing.

The cause was in `voiceChat.js`: `handleIncomingAudio()` pushed every chunk into
an `incomingTransmissions` Map and played nothing. Playback only happened in
`handleTransmissionEnded()`, which combined the whole transmission into one Blob
and ran `decodeAudioData()` on it.

That design was forced by the transport. `MediaRecorder` produces WebM/Opus, and
its chunks are fragments of a stream: only the first one carries the container
header, so `decodeAudioData()` fails on the rest. Accumulating until the end was
the only way to hand the Web Audio API something it could decode.

## Approach

Stop using a container format. Capture raw PCM, and send small frames that are
individually playable.

```
                    sender                                    receiver
getUserMedia
  -> MediaStreamAudioSourceNode
  -> AudioWorklet (frames the 128-sample quanta)
  -> linear resample to 16 kHz          socket.io      -> linear resample to the
  -> Int16                          ------------->        AudioContext rate
  -> socket emit (every ~80ms)                         -> AudioBuffer
                                                       -> scheduled on the
                                                          speaker's timeline
```

Frames are emitted while the button is still held, so audio starts playing a
few hundred milliseconds after the speaker starts talking, no matter how long
they talk for.

### Why raw PCM rather than MSE or per-chunk MediaRecorder

- **MediaSource Extensions** would keep Opus compression, but MSE cannot play
  `audio/webm;codecs=opus` on Safari or iOS, and `MediaRecorder` on iOS produces
  MP4/AAC rather than WebM. For a game played on phones outdoors that rules it
  out.
- **Restarting MediaRecorder per chunk** makes each blob a complete file, but
  drops several milliseconds of audio at every restart and clicks audibly.
- **Raw PCM** behaves identically on iOS, Android, Firefox and desktop Chrome,
  needs no codec negotiation, and every frame stands on its own. The cost is
  bandwidth.

### Bandwidth

16 kHz mono Int16 is 32 KB/s (256 kbps) while someone is actually talking, and
zero the rest of the time. A ten second transmission is about 320 KB. Tunable
via `VoiceChat.config.targetSampleRate`.

### Latency budget

| Stage | Typical |
| --- | --- |
| Frame accumulation | 80ms (100ms on mobile) |
| Network relay | measured at ~4ms on a LAN |
| Receive jitter buffer | 120ms (160ms on mobile) |
| **Total** | **~210-270ms** |

Measured end to end with two browsers against the real server: the receiving
client's buffered lead stayed between 259ms and 270ms across a continuous 30
second transmission, with 301 of 301 frames played and no resyncs.

## Receive-side scheduling

Each speaker gets their own timeline in `audioPlayback.js`:

- the first frame of a burst is scheduled `jitterBufferMs` ahead of
  `audioContext.currentTime`
- each later frame starts exactly where the previous one ended, so playback is
  gapless
- if the stream runs dry (a network stall), the timeline resyncs to
  `now + jitterBufferMs` rather than playing late
- if buffered audio exceeds `maxLeadMs`, frames are dropped so latency stays
  bounded
- a speaker is retired only once their buffered audio has finished playing, and
  a watchdog retires them anyway if frames simply stop arriving

Because timelines are per speaker, two people talking at once are **mixed**
rather than queued behind one another.

Frames are resampled to the AudioContext's own rate on arrival, with the
resampler state carried between frames. Leaving that to `AudioBufferSourceNode`
instead would round each frame's length independently and click at every frame
boundary.

## Other fixes made at the same time

| Problem | Fix |
| --- | --- |
| Releasing push-to-talk before `getUserMedia` resolved left the microphone live for 30 seconds | `startTransmission()` claims a generation number; `stopTransmission()` bumps it, and the pending start aborts |
| A new `MediaStream` was acquired on every press and never released | The stream is opened once and kept warm, then released after `micIdleReleaseMs` of inactivity |
| Every chunk passed an ack callback the server never answered, retaining an entry in `socket.acks` forever | Acks removed; audio is sent with `volatile.emit` so nothing is queued for a disconnected socket |
| Retry logic wrapped `socket.emit` in try/catch, which never throws on network failure | Removed |
| `adjustMobileAudioSettings()` mutated the config after `AudioCapture` had already copied it | Mobile settings are applied before the audio components are constructed |
| You appeared as your own speaker, because start/end were broadcast with `io.to(room)` | Server uses `socket.to(room)` throughout, and the client also filters on its own `playerId` |
| A player dropping mid-sentence left the speaker indicator stuck forever | The server closes the transmission on `disconnect` |
| The speaker indicator was driven per network packet and handled one speaker | Driven by playback start/end, and tracks a set of speakers |
| Separate mouse and touch handlers, no pointer capture, no keyboard support | Pointer Events with capture, plus space/enter hold, window blur and visibility fallbacks |
| No limits on relayed audio | Frame size cap and a per-socket rate limit |

## Tests

`npm test` runs the Node suite:

- `test/audioDsp.test.js` — resampler continuity across frame boundaries for
  integer and non-integer ratios, quantisation round trip, framing, binary
  payload coercion
- `test/audioPlayback.test.js` — frames scheduled on arrival, latency bounded
  regardless of message length, gapless joins, stall resync, drop-on-overrun,
  concurrent speakers, speaker retirement
- `test/voiceChat.test.js` — the transmission state machine, the release-during-
  acquisition race, tail flush ordering, self-echo filtering, background
  handling
- `test/pttButton.test.js` — press/release bookkeeping and every path that must
  release the microphone
- `test/voiceChatHandler.test.js` — relay scope, validation, rate limiting,
  disconnect cleanup
