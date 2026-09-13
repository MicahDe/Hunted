/**
 * Audio Capture Module for HUNTED Voice Chat
 *
 * Captures raw PCM from the microphone and emits small fixed-size frames while
 * the microphone is open, so audio can be streamed live instead of being
 * assembled into a file at the end of the transmission.
 *
 * Pipeline:
 *   getUserMedia -> MediaStreamAudioSourceNode -> AudioWorklet (framer)
 *     -> linear resample to targetSampleRate -> Int16 PCM -> onFrame callback
 *
 * Raw PCM is used deliberately. MediaRecorder's WebM/Opus chunks are fragments
 * of a stream and are not individually decodable, which is what forced the old
 * "accumulate everything, play at the end" design. PCM frames are decodable on
 * their own, need no container, and behave identically on iOS, Android and
 * desktop. The cost is bandwidth: 16 kHz mono Int16 is ~32 KB/s while talking.
 */

/**
 * Resampling, framing and quantisation helpers live in audioDsp.js so the
 * capture and playback sides share one implementation.
 */
// Wrapped so that the shared DSP names do not collide with the other
// voice chat modules in the page's single global scope.
(function (root) {
  const { LinearResampler, FrameAccumulator, floatToInt16 } =
    typeof AudioDSP !== 'undefined' ? AudioDSP : require('./audioDsp');

  class AudioCapture {
    constructor(config = {}) {
      this.config = {
        // Wire sample rate. 16 kHz is plenty for voice and a quarter of the
        // bandwidth of the typical 48 kHz hardware rate.
        targetSampleRate: config.targetSampleRate || 16000,

        // Frame duration. Shorter means lower latency and more packets.
        frameMs: config.frameMs || 80,

        // Path to the AudioWorklet processor
        workletUrl: config.workletUrl || '/js/pcmRecorderWorklet.js',

        // How long the microphone stream is kept warm after a transmission ends.
        // Keeping it open makes turning the mic back on instant (no getUserMedia
        // delay, no clipped first syllable); releasing it frees the device,
        // drops the browser's recording indicator and restores the normal audio
        // output route on iOS.
        micIdleReleaseMs: config.micIdleReleaseMs !== undefined ? config.micIdleReleaseMs : 30000,

        // Max time to wait for the worklet to flush its tail frame on stop
        flushTimeoutMs: config.flushTimeoutMs || 250
      };

      this.audioContext = config.audioContext || null;
      this.ownsAudioContext = !config.audioContext;

      this.stream = null;
      this.graphStream = null;
      this.sourceNode = null;
      this.workletNode = null;
      this.scriptNode = null;
      this.sinkNode = null;

      this.resampler = null;
      this.accumulator = null;

      this.recording = false;
      this.wireSampleRate = this.config.targetSampleRate;

      this.onFrameCallback = null;
      this.onErrorCallback = null;

      this.idleReleaseTimer = null;
      this.pendingFlush = null;
      this.workletModuleLoaded = false;
    }

    /**
     * Detect if running on a mobile device
     * @returns {boolean} True if mobile device
     */
    detectMobileDevice() {
      const userAgent = navigator.userAgent.toLowerCase();
      const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
      return mobileKeywords.some((keyword) => userAgent.includes(keyword));
    }

    /**
     * Provide the AudioContext to use (shared with playback).
     * @param {AudioContext} audioContext
     */
    setAudioContext(audioContext) {
      this.audioContext = audioContext;
      this.ownsAudioContext = false;
    }

    /**
     * Get (creating if needed) the AudioContext used for capture.
     * @returns {AudioContext}
     */
    getAudioContext() {
      if (!this.audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
          throw new Error('Web Audio API is not supported in this browser');
        }

        this.audioContext = new AudioContextClass();
        this.ownsAudioContext = true;
      }

      return this.audioContext;
    }

    /**
     * True when a usable microphone stream is already open.
     * @returns {boolean}
     */
    isStreamLive() {
      if (!this.stream) {
        return false;
      }

      const tracks = this.stream.getAudioTracks();
      return tracks.length > 0 && tracks.some((track) => track.readyState === 'live');
    }

    /**
     * Request microphone access from the user, reusing the existing stream when
     * one is already open.
     * @returns {Promise<MediaStream>}
     * @throws {Error} If microphone access is denied or unavailable
     */
    async requestMicrophoneAccess() {
      this.cancelIdleRelease();

      if (this.isStreamLive()) {
        return this.stream;
      }

      // A dead stream from a previous session would otherwise linger
      this.releaseStream();

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia is not supported in this browser');
        }

        const isMobile = this.detectMobileDevice();

        // Let mobile browsers pick their own sample rate; we resample anyway
        const constraints = {
          audio: isMobile
            ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
              }
            : {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000
              }
        };

        console.log('Requesting microphone access with constraints:', constraints);
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('Microphone access granted');

        this.setupStreamEndedListener();

        return this.stream;
      } catch (error) {
        console.error('Microphone access error:', error);

        let userMessage = 'Failed to access microphone';

        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          userMessage = 'Microphone access denied. Please enable microphone permissions in your browser settings.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          userMessage = 'No microphone found. Please connect a microphone and try again.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
          userMessage = 'Microphone is already in use by another application.';
        } else if (error.name === 'OverconstrainedError') {
          if (this.detectMobileDevice()) {
            console.warn('Overconstrained error on mobile, retrying with minimal constraints');
            return this.requestMicrophoneAccessFallback();
          }
          userMessage = 'Microphone does not meet the required specifications.';
        } else if (error.name === 'SecurityError') {
          userMessage = 'Microphone access blocked due to security restrictions.';
        }

        const enhancedError = new Error(userMessage);
        enhancedError.originalError = error;
        enhancedError.errorType = error.name;
        throw enhancedError;
      }
    }

    /**
     * Fallback microphone access with minimal constraints (mobile compatibility)
     * @returns {Promise<MediaStream>}
     */
    async requestMicrophoneAccessFallback() {
      try {
        console.log('Attempting microphone access with minimal constraints (fallback)');

        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Microphone access granted (fallback mode)');

        this.setupStreamEndedListener();

        return this.stream;
      } catch (error) {
        console.error('Fallback microphone access failed:', error);

        const enhancedError = new Error('Failed to access microphone even with minimal requirements');
        enhancedError.originalError = error;
        enhancedError.errorType = error.name;
        throw enhancedError;
      }
    }

    /**
     * Notice the microphone being unplugged or revoked mid-session
     */
    setupStreamEndedListener() {
      if (!this.stream) {
        return;
      }

      this.stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          console.warn('Microphone track ended (disconnected or revoked)');

          const wasRecording = this.recording;
          this.recording = false;
          this.teardownGraph();
          this.releaseStream();

          if (this.onErrorCallback) {
            const error = new Error('Microphone disconnected');
            error.errorType = 'DeviceDisconnected';
            error.wasRecording = wasRecording;
            this.onErrorCallback(error);
          }
        };
      });
    }

    /**
     * Open the microphone and build the capture graph without transmitting yet.
     * Idempotent, so it is safe to call on every press.
     * @returns {Promise<void>}
     */
    async prepare() {
      const audioContext = this.getAudioContext();

      await this.requestMicrophoneAccess();

      // Mobile browsers hand back a suspended context until a user gesture
      if (audioContext.state === 'suspended') {
        try {
          await audioContext.resume();
        } catch (error) {
          console.warn('Could not resume AudioContext for capture:', error);
        }
      }

      // Reuse the existing graph unless it was built for a stream we have since
      // released (for example after an idle timeout)
      if (this.sourceNode && this.getProcessingNode() && this.graphStream === this.stream) {
        return;
      }

      this.teardownGraph();

      const contextRate = audioContext.sampleRate;

      // Never upsample: if the hardware runs below the target, send its rate
      this.wireSampleRate = Math.min(this.config.targetSampleRate, contextRate);
      this.resampler = new LinearResampler(contextRate, this.wireSampleRate);

      const frameSize = Math.max(128, Math.round((contextRate * this.config.frameMs) / 1000));

      this.sourceNode = audioContext.createMediaStreamSource(this.stream);

      // A muted sink keeps the graph pulling without the user hearing themselves
      this.sinkNode = audioContext.createGain();
      this.sinkNode.gain.value = 0;
      this.sinkNode.connect(audioContext.destination);

      const useWorklet = typeof AudioWorkletNode !== 'undefined' && audioContext.audioWorklet;

      if (useWorklet) {
        try {
          await this.setupWorkletNode(audioContext, frameSize);
        } catch (error) {
          console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', error);
          this.setupScriptProcessorNode(audioContext, frameSize);
        }
      } else {
        this.setupScriptProcessorNode(audioContext, frameSize);
      }

      const processingNode = this.getProcessingNode();
      this.sourceNode.connect(processingNode);
      processingNode.connect(this.sinkNode);
      this.graphStream = this.stream;

      console.log(
        `Capture graph ready: ${contextRate} Hz context, ${frameSize} sample frames ` +
          `(${this.config.frameMs}ms), sending at ${this.wireSampleRate} Hz via ` +
          `${this.workletNode ? 'AudioWorklet' : 'ScriptProcessor'}`
      );
    }

    /**
     * Build the AudioWorklet-based framer (preferred path)
     * @param {AudioContext} audioContext
     * @param {number} frameSize
     */
    async setupWorkletNode(audioContext, frameSize) {
      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.config.workletUrl);
        this.workletModuleLoaded = true;
      }

      this.workletNode = new AudioWorkletNode(audioContext, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { frameSize }
      });

      this.workletNode.port.onmessage = (event) => {
        const message = event.data;
        if (!message) {
          return;
        }

        if (message.type === 'frame') {
          this.emitFrame(message.samples, !!message.final);
        } else if (message.type === 'flushed' && this.pendingFlush) {
          this.pendingFlush();
        }
      };

      this.workletNode.onprocessorerror = (event) => {
        console.error('AudioWorklet processor error:', event);

        if (this.onErrorCallback) {
          this.onErrorCallback(new Error('Audio processing failed unexpectedly'));
        }
      };
    }

    /**
     * Build the ScriptProcessorNode framer (fallback for older browsers)
     * @param {AudioContext} audioContext
     * @param {number} frameSize
     */
    setupScriptProcessorNode(audioContext, frameSize) {
      // ScriptProcessor buffer sizes must be a power of two between 256 and 16384
      const bufferSize = 2048;

      this.accumulator = new FrameAccumulator(frameSize);
      this.scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptNode.onaudioprocess = (event) => {
        if (!this.recording) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        this.accumulator.push(input, (frame) => this.emitFrame(frame, false));
      };
    }

    /**
     * @returns {AudioNode|null} Whichever framer node is in use
     */
    getProcessingNode() {
      return this.workletNode || this.scriptNode;
    }

    /**
     * Resample, quantise and hand one frame to the consumer
     * @param {Float32Array} samples - Frame at the AudioContext's rate
     * @param {boolean} final - True for the trailing frame of a transmission
     */
    emitFrame(samples, final) {
      if (!this.onFrameCallback || !samples || samples.length === 0) {
        return;
      }

      try {
        const resampled = this.resampler ? this.resampler.process(samples) : samples;

        if (resampled.length === 0) {
          return;
        }

        this.onFrameCallback(floatToInt16(resampled), {
          sampleRate: this.wireSampleRate,
          final: final
        });
      } catch (error) {
        console.error('Failed to process audio frame:', error);

        if (this.onErrorCallback) {
          this.onErrorCallback(error);
        }
      }
    }

    /**
     * Begin streaming frames. prepare() must have completed first.
     * @param {Function} onFrame - Called with (Int16Array, {sampleRate, final})
     * @param {Function} [onError] - Called on capture errors
     */
    start(onFrame, onError = null) {
      const processingNode = this.getProcessingNode();

      if (!processingNode) {
        throw new Error('Capture graph not ready. Call prepare() first.');
      }

      this.cancelIdleRelease();

      this.onFrameCallback = onFrame;
      this.onErrorCallback = onError;

      if (this.resampler) {
        this.resampler.reset();
      }

      if (this.accumulator) {
        this.accumulator.reset();
      }

      this.recording = true;

      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'start' });
      }

      console.log('PCM capture started');
    }

    /**
     * Stop streaming, flushing the trailing partial frame so the end of the
     * sentence is not clipped.
     * @returns {Promise<void>} Resolves once the tail frame has been emitted
     */
    async stop() {
      if (!this.recording) {
        return;
      }

      this.recording = false;

      if (this.workletNode) {
        await this.flushWorklet();
      } else if (this.accumulator) {
        this.accumulator.flush((frame) => this.emitFrame(frame, true));
      }

      this.scheduleIdleRelease();

      console.log('PCM capture stopped');
    }

    /**
     * Ask the worklet to emit its partial frame and wait for confirmation
     * @returns {Promise<void>}
     */
    flushWorklet() {
      return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          this.pendingFlush = null;
          clearTimeout(timeout);
          resolve();
        };

        const timeout = setTimeout(() => {
          console.warn('Timed out waiting for capture flush');
          finish();
        }, this.config.flushTimeoutMs);

        this.pendingFlush = finish;
        this.workletNode.port.postMessage({ type: 'stop' });
      });
    }

    /**
     * Release the microphone after a period of inactivity
     */
    scheduleIdleRelease() {
      this.cancelIdleRelease();

      if (!this.config.micIdleReleaseMs) {
        return;
      }

      this.idleReleaseTimer = setTimeout(() => {
        this.idleReleaseTimer = null;

        if (!this.recording) {
          console.log('Releasing idle microphone stream');
          this.teardownGraph();
          this.releaseStream();
        }
      }, this.config.micIdleReleaseMs);
    }

    cancelIdleRelease() {
      if (this.idleReleaseTimer) {
        clearTimeout(this.idleReleaseTimer);
        this.idleReleaseTimer = null;
      }
    }

    /**
     * Disconnect and drop the audio graph nodes (keeps the stream)
     */
    teardownGraph() {
      if (this.workletNode) {
        try {
          this.workletNode.port.onmessage = null;
          this.workletNode.disconnect();
        } catch (error) {
          console.warn('Error disconnecting worklet node:', error);
        }
        this.workletNode = null;
      }

      if (this.scriptNode) {
        try {
          this.scriptNode.onaudioprocess = null;
          this.scriptNode.disconnect();
        } catch (error) {
          console.warn('Error disconnecting script processor node:', error);
        }
        this.scriptNode = null;
      }

      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (error) {
          console.warn('Error disconnecting source node:', error);
        }
        this.sourceNode = null;
      }

      if (this.sinkNode) {
        try {
          this.sinkNode.disconnect();
        } catch (error) {
          console.warn('Error disconnecting sink node:', error);
        }
        this.sinkNode = null;
      }

      // A stop() waiting on the worklet's flush will never hear back now that
      // the port is gone, so release it rather than letting it time out
      if (this.pendingFlush) {
        const finishFlush = this.pendingFlush;
        this.pendingFlush = null;
        finishFlush();
      }

      this.accumulator = null;
      this.graphStream = null;
    }

    /**
     * Stop the microphone tracks and drop the stream
     */
    releaseStream() {
      if (!this.stream) {
        return;
      }

      this.stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });

      this.stream = null;
      console.log('Microphone stream released');
    }

    /**
     * Release every resource held by this capture instance
     */
    release() {
      this.recording = false;
      this.cancelIdleRelease();
      this.teardownGraph();
      this.releaseStream();

      this.resampler = null;
      this.onFrameCallback = null;
      this.onErrorCallback = null;

      if (this.ownsAudioContext && this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch((error) => {
          console.warn('Error closing capture AudioContext:', error);
        });
      }

      this.audioContext = null;
      this.workletModuleLoaded = false;

      console.log('Audio capture resources released');
    }

    /**
     * @returns {boolean} True while frames are being emitted
     */
    isRecording() {
      return this.recording;
    }

    /**
     * @returns {MediaStream|null}
     */
    getStream() {
      return this.stream;
    }

    /**
     * @returns {number} Sample rate of the frames being emitted
     */
    getWireSampleRate() {
      return this.wireSampleRate;
    }
  }

  root.AudioCapture = AudioCapture;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioCapture;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
