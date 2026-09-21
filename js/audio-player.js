export class AudioPlayer {
  constructor(audio = new window.Audio()) {
    this.audio = audio; this.objectUrl = ""; this.handlers = {}; this.audio.preload = "auto";
    this.audio.addEventListener("play", () => this.handlers.onPlay?.());
    this.audio.addEventListener("pause", () => this.handlers.onPause?.());
    this.audio.addEventListener("ended", () => this.handlers.onEnd?.());
    this.audio.addEventListener("timeupdate", () => this.handlers.onTime?.(this.audio.currentTime));
    this.audio.addEventListener("error", () => this.handlers.onError?.(new Error("Generated audio could not be played.")));
  }
  setHandlers(handlers) { this.handlers = handlers; }
  async load(blob, { rate = 1, position = 0 } = {}) {
    this.pause();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob); this.audio.src = this.objectUrl; this.audio.playbackRate = rate;
    await new Promise((resolve, reject) => {
      const cleanup = () => { this.audio.removeEventListener("canplay", ready); this.audio.removeEventListener("error", failed); };
      const ready = () => { cleanup(); this.audio.currentTime = Math.min(position || 0, Number.isFinite(this.audio.duration) ? this.audio.duration : position || 0); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Generated audio could not be loaded.")); };
      this.audio.addEventListener("canplay", ready, { once: true }); this.audio.addEventListener("error", failed, { once: true }); this.audio.load();
    });
  }
  play() { return this.audio.play(); }
  pause() { this.audio.pause(); }
  setRate(rate) { this.audio.playbackRate = rate; }
  get currentTime() { return this.audio.currentTime || 0; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }
  destroy() { this.pause(); if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); }
}
