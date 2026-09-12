/**
 * Minimal AudioContext stand-in for testing the voice chat scheduling logic in
 * Node. It records what was scheduled and when, and lets a test advance the
 * clock by hand.
 */

class FakeGainNode {
  constructor(context) {
    this.context = context;
    this.gain = {
      value: 1,
      setTargetAtTime: (value) => {
        this.gain.value = value;
      }
    };
    this.connectedTo = null;
    this.disconnected = false;
  }

  connect(destination) {
    this.connectedTo = destination;
    return destination;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeBufferSource {
  constructor(context) {
    this.context = context;
    this.buffer = null;
    this.onended = null;
    this.startedAt = null;
    this.stopped = false;
    this.connectedTo = null;
  }

  connect(destination) {
    this.connectedTo = destination;
    return destination;
  }

  disconnect() {}

  start(when) {
    this.startedAt = when === undefined ? this.context.currentTime : when;
    this.context.scheduled.push(this);
  }

  stop() {
    this.stopped = true;
  }
}

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = new Float32Array(length);
  }

  getChannelData() {
    return this._data;
  }

  copyToChannel(source) {
    this._data.set(source);
  }
}

class FakeAudioContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = { name: 'destination' };

    // Every source that had start() called on it, in order
    this.scheduled = [];
    this.closed = false;
  }

  createGain() {
    return new FakeGainNode(this);
  }

  createBufferSource() {
    return new FakeBufferSource(this);
  }

  createBuffer(channels, length, sampleRate) {
    if (length <= 0) {
      throw new Error('createBuffer requires a positive length');
    }
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  createMediaStreamSource() {
    return new FakeGainNode(this);
  }

  async resume() {
    this.state = 'running';
  }

  async suspend() {
    this.state = 'suspended';
  }

  async close() {
    this.closed = true;
    this.state = 'closed';
  }

  /**
   * Move the audio clock forward, as playback would.
   * @param {number} seconds
   */
  advance(seconds) {
    this.currentTime += seconds;
  }
}

module.exports = { FakeAudioContext, FakeAudioBuffer, FakeBufferSource, FakeGainNode };
