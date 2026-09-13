# Live PCM Streaming

Supersedes the "Chunk Accumulation Strategy" section of
[audio-empty-data-fix.md](./audio-empty-data-fix.md).

## Problem

Voice replies felt like they took roughly twice as long as they should. A
listener heard nothing at all until the speaker stopped transmitting, so a
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

Frames are emitted continuously while the microphone is open, so audio starts
playing a few hundred milliseconds after the speaker starts talking, no matter
how long they talk for.

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
| Turning the microphone off before `getUserMedia` resolved left it live for 30 seconds | `startTransmission()` claims a generation number; `stopTransmission()` bumps it, and the pending start aborts |
| A new `MediaStream` was acquired every time and never released | The stream is opened once and kept warm, then released after `micIdleReleaseMs` of inactivity |
| Every chunk passed an ack callback the server never answered, retaining an entry in `socket.acks` forever | Acks removed; audio is sent with `volatile.emit` so nothing is queued for a disconnected socket |
| Retry logic wrapped `socket.emit` in try/catch, which never throws on network failure | Removed |
| `adjustMobileAudioSettings()` mutated the config after `AudioCapture` had already copied it | Mobile settings are applied before the audio components are constructed |
| You appeared as your own speaker, because start/end were broadcast with `io.to(room)` | Server uses `socket.to(room)` throughout, and the client also filters on its own `playerId` |
| A player dropping mid-sentence left the speaker indicator stuck forever | The server closes the transmission on `disconnect` |
| The speaker indicator was driven per network packet and handled one speaker | Driven by playback start/end, and tracks a set of speakers |
| Separate mouse and touch handlers, no pointer capture, no keyboard support | Replaced by the microphone toggle described below |
| No limits on relayed audio | Frame size cap and a per-socket rate limit |

## From hold-to-talk to a microphone toggle

The original control was a hold-to-talk button: press and hold to transmit.
It had a defect that made it unusable in practice. Two rules in
`voiceChat.css`, in the iOS `@supports` block and the Android `@media` block,
set `touch-action: manipulation` on the button. Both come later in the file than
the `touch-action: none` the pointer handling relied on, at equal specificity,
so they won on every phone. `manipulation` still permits panning, so any thumb
movement let the browser claim the touch as a scroll gesture and fire
`pointercancel`, which the handler correctly read as a release. Transmission
stopped if the user's thumb drifted at all.

Rather than fight the gesture, the control became a toggle: tap to open the
microphone, tap again to close it. The microphone starts closed and only ever
opens because someone tapped the button.

- The button listens for `click`, not raw pointer events. The browser decides
  what counts as a tap, so thumb drift is tolerated, and Enter/Space on a
  focused `<button>` arrive through the same path for free.
- `touch-action: manipulation` is now the right value and is left alone.
- The 30 second cap on a single transmission is gone, client and server. It made
  sense when a transmission lasted as long as a button was held; on a latched
  microphone it would silently mute someone mid-conversation. A client that
  stops sending without saying so is still covered by the receiver's silence
  watchdog, and one that drops off entirely by the server's disconnect handler.
- The microphone still closes by itself when the app is backgrounded, when the
  device disappears, and when voice chat is switched off in settings. The button
  mirrors `VoiceChat`'s state rather than tracking its own, so it cannot claim to
  be open after transmission has stopped for any of those reasons.

### Consequence: it is an open channel

While the microphone is on, everything is transmitted: roughly 32 KB/s
continuously, and teammates hear background noise for as long as it is open.
That is the deliberate trade for a predictable control. The live state is made
unmissable (red button, "LIVE", a struck-through mic icon when closed) because
forgetting you are open matters in this game, where a runner broadcasting to
hunters is a real cost.

If continuous transmission turns out to be too expensive, the place to add voice
activity detection is `AudioCapture.emitFrame()`: compute the frame's RMS and
skip the send below a threshold, with a hang time of a few hundred milliseconds
so word endings are not clipped.

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
- `test/micButton.test.js` — toggle bookkeeping, and every path that must leave
  the microphone closed
- `test/voiceChatHandler.test.js` — relay scope, validation, rate limiting,
  disconnect cleanup
