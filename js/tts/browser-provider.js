import { BrowserSpeechEngine, voiceKey } from "../speech-engine.js";

export class BrowserTtsProvider {
  constructor(synth = window.speechSynthesis) {
    this.id = "browser";
    this.name = "Standard Audio";
    this.kind = "speech";
    this.engine = new BrowserSpeechEngine(synth);
  }
  async isAvailable() { return (await this.engine.loadVoices()).length > 0; }
  async getVoices() {
    return (await this.engine.loadVoices()).map((voice) => ({ id: voiceKey(voice), name: voice.name, language: voice.lang, provider: this.id, raw: voice }));
  }
  speak(text, options = {}) {
    const voice = this.engine.resolveVoice(options.voiceId);
    this.engine.speak(text, { voice, rate: options.rate, onEnd: options.onEnd, onError: options.onError });
  }
  stop() { this.engine.stop(); }
}
