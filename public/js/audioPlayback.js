/**
 * Audio Playback Module for HUNTED Voice Chat
 *
 * Plays incoming PCM frames as they arrive rather than waiting for the speaker
 * to finish. Each speaker gets their own scheduling timeline and gain node, so
 * frames play back gaplessly and two people talking at once are mixed instead
 * of queued behind one another.
 *
 * Scheduling model, per speaker:
 *   - the first frame is scheduled a small jitter buffer ahead of the clock
 *   - each subsequent frame is scheduled exactly where the previous one ended
 *   - if the network stalls long enough that we run dry, the timeline resyncs
 *   - if we somehow buffer too far ahead, frames are dropped to bound latency
 */

// Wrapped so that the shared DSP names do not collide with the other
// voice chat modules in the page's single global scope.
(function (root) {
  const { LinearResampler, int16ToFloat, toInt16Array } =
    typeof AudioDSP !== 'undefined' ? AudioDSP : require('./audioDsp');

  class AudioPlayback {
    constructor(audioContext = null, config = {}) {
      this.config = {
        // How far ahead of the clock the first frame of a burst is scheduled.
        // This is the latency we trade for tolerance of network jitter.
        jitterBufferMs: config.jitterBufferMs || 120,

        // Hard ceiling on buffered audio; beyond this we drop frames rather than
        // let the delay grow without bound.
        maxLeadMs: config.maxLeadMs || 1000,

        // Treat a speaker as finished this long after their last frame, in case
        // the transmission-end event never arrives (sender crashed, dropped out).
        speakerTimeoutMs: config.speakerTimeoutMs || 1500
      };

      this.audioContext = audioContext || this.createAudioContext();
      this.ownsAudioContext = !audioContext;

      // Volume control (0.0 to 1.0)
      this.volume = 1.0;
      this.masterGain = null;

      if (this.audioContext) {
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = this.volume;
        this.masterGain.connect(this.audioContext.destination);
      }

      // playerId -> speaker timeline state
      this.speakers = new Map();

      // Callbacks
      this.onSpeakerStartCallback = null;
      this.onSpeakerEndCallback = null;
      this.onErrorCallback = null;
    }

    /**
     * Create an AudioContext with browser compatibility
     * @returns {AudioContext|null} The audio context or null if not supported
     */
    createAudioContext() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
          console.error('Web Audio API is not supported in this browser');
          return null;
        }

        const context = new AudioContextClass();
        console.log(`AudioContext created successfully (${context.sampleRate} Hz, state: ${context.state})`);
        return context;
      } catch (error) {
        console.error('Failed to create AudioContext:', error);
        return null;
      }
    }

    /**
     * Get (creating if needed) the timeline state for a speaker
     * @param {Object} metadata - Speaker metadata
     * @returns {Object|null} Speaker state
     */
    getOrCreateSpeaker(metadata) {
      const playerId = metadata && metadata.playerId;

      if (!playerId || !this.audioContext) {
        return null;
      }

      let speaker = this.speakers.get(playerId);

      if (speaker) {
        // Refresh display metadata in case the username/team changed
        if (metadata.username) {
          speaker.metadata.username = metadata.username;
        }
        if (metadata.team) {
          speaker.metadata.team = metadata.team;
        }
        return speaker;
      }

      const gain = this.audioContext.createGain();
      gain.gain.value = 1;
      gain.connect(this.masterGain);

      speaker = {
        playerId: playerId,
        metadata: {
          playerId: playerId,
          username: metadata.username || 'Unknown',
          team: metadata.team || 'unknown'
        },
        gain: gain,
        resampler: null,
        frameSampleRate: null,
        // Context time at which the next frame should start; 0 means "not running"
        nextTime: 0,
        active: false,
        sources: new Set(),
        endTimer: null,
        silenceTimer: null,
        stats: { framesPlayed: 0, framesDropped: 0, resyncs: 0 }
      };

      this.speakers.set(playerId, speaker);
      return speaker;
    }

    /**
     * Mark a speaker as live before any audio has arrived, so the UI can react
     * the instant they turn their microphone on.
     * @param {Object} metadata - {playerId, username, team}
     */
    noteSpeakerStart(metadata) {
      const speaker = this.getOrCreateSpeaker(metadata);

      if (!speaker) {
        return;
      }

      // A new burst starts a fresh timeline
      this.clearTimers(speaker);
      speaker.nextTime = 0;

      if (speaker.resampler) {
        speaker.resampler.reset();
      }

      this.armSilenceTimer(speaker);
      this.activate(speaker);
    }

    /**
     * Schedule one PCM frame for playback.
     * @param {ArrayBuffer|Uint8Array|Int16Array} audioData - 16-bit mono PCM
     * @param {Object} metadata - {playerId, username, team, sampleRate, sequenceNumber}
     */
    enqueue(audioData, metadata = {}) {
      if (!this.audioContext) {
        this.reportError(new Error('AudioContext not available for playback'), metadata);
        return;
      }

      const samples = toInt16Array(audioData);

      if (!samples || samples.length === 0) {
        console.warn('Ignoring empty audio frame from', metadata.username);
        return;
      }

      const speaker = this.getOrCreateSpeaker(metadata);

      if (!speaker) {
        return;
      }

      try {
        const frameRate = metadata.sampleRate || 16000;
        const contextRate = this.audioContext.sampleRate;

        // Resample to the context rate with state carried between frames. Letting
        // AudioBufferSourceNode do the conversion instead would round each frame's
        // length independently and click at every frame boundary.
        if (!speaker.resampler || speaker.frameSampleRate !== frameRate) {
          speaker.resampler = new LinearResampler(frameRate, contextRate);
          speaker.frameSampleRate = frameRate;
        }

        const floatSamples = speaker.resampler.process(int16ToFloat(samples));

        if (floatSamples.length === 0) {
          return;
        }

        const buffer = this.audioContext.createBuffer(1, floatSamples.length, contextRate);

        if (buffer.copyToChannel) {
          buffer.copyToChannel(floatSamples, 0);
        } else {
          buffer.getChannelData(0).set(floatSamples);
        }

        if (!this.scheduleBuffer(speaker, buffer)) {
          return;
        }

        speaker.stats.framesPlayed++;

        this.armSilenceTimer(speaker);
        this.activate(speaker);
      } catch (error) {
        this.reportError(error, metadata);
      }
    }

    /**
     * Place a decoded buffer on a speaker's timeline
     * @param {Object} speaker - Speaker state
     * @param {AudioBuffer} buffer - Audio to play
     * @returns {boolean} False if the frame was dropped
     */
    scheduleBuffer(speaker, buffer) {
      const now = this.audioContext.currentTime;
      const jitter = this.config.jitterBufferMs / 1000;
      const maxLead = this.config.maxLeadMs / 1000;

      // Ran dry (first frame of a burst, or a network stall): restart the
      // timeline a jitter buffer ahead of the clock.
      if (speaker.nextTime < now + 0.005) {
        if (speaker.nextTime > 0) {
          speaker.stats.resyncs++;
        }
        speaker.nextTime = now + jitter;
      }

      // Buffered too far ahead: drop rather than let latency creep up
      if (speaker.nextTime - now > maxLead) {
        speaker.stats.framesDropped++;
        console.warn(
          `Dropping audio frame from ${speaker.metadata.username}: ` +
            `${Math.round((speaker.nextTime - now) * 1000)}ms already buffered`
        );
        return false;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(speaker.gain);

      source.onended = () => {
        speaker.sources.delete(source);

        try {
          source.disconnect();
        } catch (error) {
          // Already disconnected
        }
      };

      source.start(speaker.nextTime);
      speaker.sources.add(source);
      speaker.nextTime += buffer.duration;

      return true;
    }

    /**
     * Note that a speaker closed their microphone. Their buffered audio keeps
     * playing; the speaker is only retired once it has all been heard.
     * @param {string} playerId
     */
    noteSpeakerEnd(playerId) {
      const speaker = this.speakers.get(playerId);

      if (!speaker) {
        return;
      }

      this.clearTimers(speaker);

      const remainingMs = Math.max(0, (speaker.nextTime - this.audioContext.currentTime) * 1000);

      speaker.endTimer = setTimeout(() => {
        speaker.endTimer = null;
        this.deactivate(speaker);
      }, remainingMs + 60);
    }

    /**
     * Retire a speaker if no further frames arrive, covering the case where the
     * transmission-end event is lost.
     * @param {Object} speaker
     */
    armSilenceTimer(speaker) {
      if (speaker.silenceTimer) {
        clearTimeout(speaker.silenceTimer);
      }

      speaker.silenceTimer = setTimeout(() => {
        speaker.silenceTimer = null;
        console.log(`No audio from ${speaker.metadata.username} for a while, ending their turn`);
        this.deactivate(speaker);
      }, this.config.speakerTimeoutMs);
    }

    clearTimers(speaker) {
      if (speaker.endTimer) {
        clearTimeout(speaker.endTimer);
        speaker.endTimer = null;
      }

      if (speaker.silenceTimer) {
        clearTimeout(speaker.silenceTimer);
        speaker.silenceTimer = null;
      }
    }

    /**
     * @param {Object} speaker
     */
    activate(speaker) {
      if (speaker.active) {
        return;
      }

      speaker.active = true;

      if (this.onSpeakerStartCallback) {
        this.onSpeakerStartCallback(speaker.metadata);
      }
    }

    /**
     * @param {Object} speaker
     */
    deactivate(speaker) {
      this.clearTimers(speaker);
      speaker.nextTime = 0;

      if (!speaker.active) {
        return;
      }

      speaker.active = false;

      console.log(
        `Speaker ${speaker.metadata.username} finished ` +
          `(${speaker.stats.framesPlayed} frames, ${speaker.stats.framesDropped} dropped, ` +
          `${speaker.stats.resyncs} resyncs)`
      );

      if (this.onSpeakerEndCallback) {
        this.onSpeakerEndCallback(speaker.metadata);
      }
    }

    /**
     * Stop one speaker immediately, discarding anything still scheduled
     * @param {string} playerId
     */
    stopSpeaker(playerId) {
      const speaker = this.speakers.get(playerId);

      if (!speaker) {
        return;
      }

      this.stopSources(speaker);
      this.deactivate(speaker);
    }

    /**
     * @param {Object} speaker
     */
    stopSources(speaker) {
      speaker.sources.forEach((source) => {
        try {
          source.onended = null;
          source.stop();
          source.disconnect();
        } catch (error) {
          // Source may already have finished
        }
      });

      speaker.sources.clear();
      speaker.nextTime = 0;
    }

    /**
     * Stop all playback and clear every timeline
     */
    stop() {
      this.speakers.forEach((speaker) => {
        this.stopSources(speaker);
        this.deactivate(speaker);
      });

      console.log('Playback stopped');
    }

    /**
     * Drop anything still scheduled but keep the speakers registered.
     * Used when returning from the background, where scheduled audio is stale.
     */
    resetTimelines() {
      this.speakers.forEach((speaker) => {
        this.stopSources(speaker);

        if (speaker.resampler) {
          speaker.resampler.reset();
        }
      });
    }

    /**
     * Forget a speaker entirely (they left the game)
     * @param {string} playerId
     */
    removeSpeaker(playerId) {
      const speaker = this.speakers.get(playerId);

      if (!speaker) {
        return;
      }

      this.stopSources(speaker);
      this.deactivate(speaker);

      try {
        speaker.gain.disconnect();
      } catch (error) {
        // Already disconnected
      }

      this.speakers.delete(playerId);
    }

    /**
     * Set playback volume
     * @param {number} level - Volume level from 0.0 (mute) to 1.0 (full volume)
     */
    setVolume(level) {
      this.volume = Math.max(0, Math.min(1, level));

      if (this.masterGain) {
        // Ramp rather than jump, so volume changes do not click
        const now = this.audioContext ? this.audioContext.currentTime : 0;

        if (this.masterGain.gain.setTargetAtTime) {
          this.masterGain.gain.setTargetAtTime(this.volume, now, 0.015);
        } else {
          this.masterGain.gain.value = this.volume;
        }

        console.log(`Volume set to ${(this.volume * 100).toFixed(0)}%`);
      }
    }

    /**
     * @returns {number} Volume level from 0.0 to 1.0
     */
    getVolume() {
      return this.volume;
    }

    /**
     * @returns {Array<Object>} Metadata for every speaker currently talking
     */
    getActiveSpeakers() {
      const active = [];

      this.speakers.forEach((speaker) => {
        if (speaker.active) {
          active.push(speaker.metadata);
        }
      });

      return active;
    }

    /**
     * @returns {boolean} True if any speaker is currently talking
     */
    isCurrentlyPlaying() {
      return this.getActiveSpeakers().length > 0;
    }

    /**
     * @returns {number} Number of audio frames scheduled but not yet finished
     */
    getQueueSize() {
      let total = 0;

      this.speakers.forEach((speaker) => {
        total += speaker.sources.size;
      });

      return total;
    }

    /**
     * How much audio is buffered for a speaker, in milliseconds.
     * Useful for diagnosing latency.
     * @param {string} playerId
     * @returns {number}
     */
    getBufferedMs(playerId) {
      const speaker = this.speakers.get(playerId);

      if (!speaker || !this.audioContext || speaker.nextTime === 0) {
        return 0;
      }

      return Math.max(0, (speaker.nextTime - this.audioContext.currentTime) * 1000);
    }

    /**
     * @param {Error} error
     * @param {Object} metadata
     */
    reportError(error, metadata) {
      console.error('Playback error:', error);

      if (this.onErrorCallback) {
        this.onErrorCallback(error, metadata);
      }
    }

    /**
     * Set callback fired when a speaker starts talking
     * @param {Function} callback
     */
    onSpeakerStart(callback) {
      this.onSpeakerStartCallback = callback;
    }

    /**
     * Set callback fired when a speaker's audio has finished playing
     * @param {Function} callback
     */
    onSpeakerEnd(callback) {
      this.onSpeakerEndCallback = callback;
    }

    /**
     * Set callback for playback errors
     * @param {Function} callback
     */
    onError(callback) {
      this.onErrorCallback = callback;
    }

    /**
     * Resume the AudioContext. Browsers start it suspended until a user gesture.
     * @returns {Promise<boolean>} True if the context is running afterwards
     */
    async resume() {
      if (!this.audioContext) {
        return false;
      }

      if (this.audioContext.state === 'running') {
        return true;
      }

      try {
        await this.audioContext.resume();
        console.log(`AudioContext resumed (state: ${this.audioContext.state})`);
        return this.audioContext.state === 'running';
      } catch (error) {
        console.warn('Failed to resume AudioContext:', error);
        return false;
      }
    }

    /**
     * @returns {string|null} The AudioContext state or null
     */
    getContextState() {
      return this.audioContext ? this.audioContext.state : null;
    }

    /**
     * Release all resources
     */
    release() {
      this.stop();

      this.speakers.forEach((speaker) => {
        try {
          speaker.gain.disconnect();
        } catch (error) {
          // Already disconnected
        }
      });

      this.speakers.clear();

      if (this.masterGain) {
        try {
          this.masterGain.disconnect();
        } catch (error) {
          // Already disconnected
        }
        this.masterGain = null;
      }

      if (this.ownsAudioContext && this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch((error) => {
          console.warn('Error closing AudioContext:', error);
        });
      }

      this.audioContext = null;
      this.onSpeakerStartCallback = null;
      this.onSpeakerEndCallback = null;
      this.onErrorCallback = null;

      console.log('Audio playback resources released');
    }
  }

  root.AudioPlayback = AudioPlayback;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioPlayback;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
