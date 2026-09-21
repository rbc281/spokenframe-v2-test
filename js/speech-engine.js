export function splitForSpeech(text, maxLength = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const sentences = normalized.match(/[^.!?…]+[.!?…]+[\"'’”)]*|[^.!?…]+$/g) || [normalized];
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    const candidate = `${current} ${cleanSentence}`.trim();
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    flush();
    if (cleanSentence.length <= maxLength) {
      current = cleanSentence;
      continue;
    }
    const words = cleanSentence.split(/\s+/);
    for (const word of words) {
      const wordCandidate = `${current} ${word}`.trim();
      if (wordCandidate.length > maxLength && current) flush();
      current = `${current} ${word}`.trim();
    }
  }
  flush();
  return chunks;
}

export function voiceKey(voice) {
  return voice ? (voice.voiceURI || `${voice.name}|${voice.lang}`) : "";
}

export class BrowserSpeechEngine {
  constructor(synth = window.speechSynthesis) {
    this.synth = synth;
    this.voices = [];
    this.active = null;
    this.token = 0;
    this.watchdog = null;
  }

  async loadVoices(timeoutMs = 2200) {
    if (!this.synth) return [];
    const get = () => this.synth.getVoices?.() || [];
    this.voices = get();
    if (this.voices.length) return this.voices;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        this.synth.removeEventListener?.("voiceschanged", finish);
        resolve();
      };
      const poll = setInterval(() => {
        if (get().length) finish();
      }, 100);
      const timeout = setTimeout(finish, timeoutMs);
      this.synth.addEventListener?.("voiceschanged", finish, { once: true });
    });
    this.voices = get();
    return this.voices;
  }

  getVoices() {
    const available = this.synth?.getVoices?.() || this.voices;
    if (available.length) this.voices = available;
    return this.voices;
  }

  resolveVoice(savedKey, fallbackIndex = 0) {
    const voices = this.getVoices();
    if (!voices.length) return null;
    return voices.find((voice) => voiceKey(voice) === savedKey)
      || voices.find((voice) => voice.default)
      || voices[fallbackIndex % voices.length]
      || voices[0];
  }

  speak(text, { voice = null, rate = 1, onEnd = () => {}, onError = () => {} } = {}) {
    this.stop();
    const chunks = splitForSpeech(text);
    if (!chunks.length) {
      onEnd();
      return;
    }
    if (!this.synth || typeof SpeechSynthesisUtterance === "undefined") {
      onError(new Error("Speech synthesis is not available."));
      return;
    }

    const token = ++this.token;
    this.active = { chunks, index: 0, voice, rate, onEnd, onError, token, retries: 0 };
    this.#speakCurrent();
  }

  #speakCurrent() {
    const state = this.active;
    if (!state || state.token !== this.token) return;
    clearTimeout(this.watchdog);

    const utterance = new SpeechSynthesisUtterance(state.chunks[state.index]);
    if (state.voice) utterance.voice = state.voice;
    utterance.rate = Math.max(0.5, Math.min(2, Number(state.rate) || 1));
    utterance.pitch = 1;
    utterance.volume = 1;

    utterance.onend = () => {
      if (!this.active || state.token !== this.token) return;
      clearTimeout(this.watchdog);
      state.index += 1;
      state.retries = 0;
      if (state.index < state.chunks.length) {
        this.#speakCurrent();
      } else {
        this.active = null;
        state.onEnd();
      }
    };

    utterance.onerror = (event) => {
      if (!this.active || state.token !== this.token) return;
      clearTimeout(this.watchdog);
      const benign = ["interrupted", "canceled"].includes(event.error);
      if (!benign) {
        this.active = null;
        state.onError(new Error("Speech playback stopped unexpectedly."));
      }
    };

    this.synth.speak(utterance);
    const estimatedMs = Math.min(30000, Math.max(5000, utterance.text.length * 105 / utterance.rate));
    this.watchdog = setTimeout(() => {
      if (!this.active || state.token !== this.token) return;
      if (!this.synth.speaking && state.retries < 1) {
        state.retries += 1;
        this.synth.cancel();
        this.#speakCurrent();
      }
    }, estimatedMs);
  }

  stop() {
    clearTimeout(this.watchdog);
    this.token += 1;
    this.active = null;
    this.synth?.cancel?.();
  }

  preview(text, voice, rate = 1) {
    this.speak(text, { voice, rate });
  }
}
