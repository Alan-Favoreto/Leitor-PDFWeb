// SpeechEngine: wrapper robusto do window.speechSynthesis.
// Contorna os bugs conhecidos da Web Speech API:
// - getVoices() vazio no início (espera 'voiceschanged' com polling e timeout);
// - Chrome corta falas longas (~15 s) → texto dividido em pedaços + keep-alive só para vozes online;
// - cancel() dispara onerror/onend atrasados → cada fala é um "job" e eventos de utterances
//   antigas são ignorados;
// - Chrome às vezes "trava" depois de cancel() → cancel antes de cada fala, pequena espera,
//   e um vigia que fala de novo se o pedaço não começar;
// - utterances coletadas pelo GC param de disparar eventos → mantemos referência até o fim;
// - pause() não funciona no Android nem com vozes online do Chrome → pausa "suave"
//   (cancela e retoma a partir da palavra atual).

import { chunkText, cleanForSpeech, hasSpeech, wordSpanAt, DEFAULT_MAX_LENGTH } from './text-chunker.js';
import { normalizeVoice, pickDefaultVoice, pickVoiceForLang, sortVoices, voiceIdOf, voiceSpeaks } from './voices.js';

/** @typedef {import('./voices.js').Voice} Voice */

const LIMITS = {
  rate: [0.5, 2.5],
  pitch: [0, 2],
  volume: [0, 1],
};

const VOICES_TIMEOUT_MS = 3000;
const VOICES_POLL_MS = 250;
const KEEP_ALIVE_MS = 10000;
const START_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 500;
const LOST_END_TICKS = 4;
const RESPEAK_DELAY_MS = 60;
const RESUME_CHECK_MS = 400;
const RELEASE_UTTERANCE_MS = 5000;
// Caracteres por segundo aproximados a rate 1 (só para o vigia não encerrar cedo demais).
const CHARS_PER_SECOND = 14;

const IGNORABLE_ERRORS = new Set(['interrupted', 'canceled', 'cancelled']);

const ERROR_MESSAGES = {
  'not-allowed': 'O navegador só libera a voz depois de um toque ou clique na página. Toque em Play para começar.',
  'audio-busy': 'O áudio do aparelho está ocupado por outro aplicativo. Feche-o e tente de novo.',
  'audio-hardware': 'Não foi possível usar a saída de áudio do aparelho.',
  network: 'Esta voz precisa de internet e a conexão falhou. Tente de novo ou escolha uma voz local.',
  'synthesis-unavailable': 'Nenhuma voz sintética está disponível neste navegador.',
  'synthesis-failed': 'A voz falhou ao ler este trecho. Tente de novo ou escolha outra voz.',
  'language-unavailable': 'Não há voz instalada para este idioma.',
  'voice-unavailable': 'A voz escolhida não está disponível. Escolha outra nas configurações.',
  'text-too-long': 'O trecho é longo demais para esta voz.',
  'invalid-argument': 'Ajuste de voz inválido (velocidade, tom ou volume).',
};
const DEFAULT_ERROR_MESSAGE = 'A leitura em voz alta falhou. Tente de novo.';

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, value));
}

function now() {
  return Date.now();
}

function unsupportedError() {
  const err = new Error('Este navegador não tem voz sintética (Web Speech API). Use Chrome, Edge ou Safari atualizados.');
  err.code = 'TTS_UNSUPPORTED';
  return err;
}

export class SpeechEngine extends EventTarget {
  /** true se o navegador tem speechSynthesis. */
  static isSupported() {
    return typeof globalThis.speechSynthesis === 'object'
      && globalThis.speechSynthesis !== null
      && typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  /**
   * As opções são todas opcionais (servem para testes e casos especiais).
   * @param {object} [options]
   * @param {SpeechSynthesis} [options.synth]
   * @param {typeof SpeechSynthesisUtterance} [options.Utterance]
   * @param {'auto'|'native'|'soft'} [options.pauseMode] 'auto' usa pausa suave no Android e em vozes online do Chrome
   * @param {number} [options.maxChunkLength] tamanho máximo de cada pedaço falado
   * @param {string} [options.userAgent]
   */
  constructor({
    synth = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    pauseMode = 'auto',
    maxChunkLength = DEFAULT_MAX_LENGTH,
    userAgent = globalThis.navigator?.userAgent ?? '',
  } = {}) {
    super();
    this._synth = synth || null;
    this._Utterance = typeof Utterance === 'function' ? Utterance : null;
    this._pauseMode = pauseMode;
    this._maxChunk = maxChunkLength;
    this._isAndroid = /Android/i.test(userAgent);
    this._isChromium = /Chrome\/|Chromium\/|Edg\//.test(userAgent) && !/Firefox\/|CriOS\//.test(userAgent);

    /** @type {Voice[]} */
    this._voices = [];
    this._native = new Map();
    this._signature = '';
    this._voiceId = null;
    this._preferredId = null;
    this._initPromise = null;
    this._voicesReady = null;

    this._rate = 1;
    this._pitch = 1;
    this._volume = 1;

    this._state = 'idle';
    this._job = null;
    this._alive = new Set(); // referências às utterances (evita GC no Chrome)
    this._keepAlive = null;
    this._watchdog = null;
    this._unlocked = false;
  }

  /** Tipo do motor: 'browser' (voz do navegador). O NeuralSpeechEngine devolve 'neural'. */
  get kind() {
    return 'browser';
  }

  /** As vozes do navegador aceitam tom (pitch). */
  get supportsPitch() {
    return true;
  }

  // ---- vozes --------------------------------------------------------------

  /**
   * Espera as vozes carregarem (voiceschanged, polling curto, timeout de 3 s).
   * Pode ser chamado várias vezes. Resolve com a lista de vozes (pode ser vazia).
   * @param {{ preferredVoiceId?: string|null }} [options] voz salva pelo usuário
   * @returns {Promise<Voice[]>}
   */
  async init({ preferredVoiceId = null } = {}) {
    if (!this._synth || !this._Utterance) throw unsupportedError();
    if (preferredVoiceId) this._preferredId = String(preferredVoiceId);
    if (!this._initPromise) {
      this._listenVoices();
      this._initPromise = this._waitForVoices();
    }
    await this._initPromise;
    this._applyVoiceChoice();
    return this.getVoices();
  }

  /** Vozes ordenadas: pt-BR, pt-*, resto (cópia). */
  getVoices() {
    return this._voices.map((v) => ({ ...v }));
  }

  get voiceId() {
    return this._voiceId;
  }

  /** Voz atual (Voice) ou null. */
  get voice() {
    const v = this._voices.find((item) => item.id === this._voiceId);
    return v ? { ...v } : null;
  }

  /**
   * Escolhe a voz pelo id. Se as vozes ainda não carregaram, guarda e aplica depois.
   * Vale a partir da próxima fala. Retorna false se a voz não existe (a escolha fica
   * guardada caso ela apareça depois, como as vozes online do Chrome).
   */
  setVoice(id) {
    if (!id) {
      this._preferredId = null;
      this._voiceId = pickDefaultVoice(this._voices)?.id ?? null;
      return true;
    }
    this._preferredId = String(id);
    if (!this._voices.length) return true;
    if (!this._native.has(this._preferredId)) return false;
    this._voiceId = this._preferredId;
    return true;
  }

  // ---- ajustes ------------------------------------------------------------

  get rate() { return this._rate; }
  set rate(v) { this._rate = this._validate(v, 'rate', this._rate); }

  get pitch() { return this._pitch; }
  set pitch(v) { this._pitch = this._validate(v, 'pitch', this._pitch); }

  get volume() { return this._volume; }
  set volume(v) { this._volume = this._validate(v, 'volume', this._volume); }

  /** 'idle' | 'speaking' | 'paused' */
  get state() {
    return this._state;
  }

  // ---- fala ---------------------------------------------------------------

  /**
   * Chame de forma síncrona dentro de um toque/clique (ex.: no botão Play) antes da
   * primeira fala. Necessário no iOS/Safari, que só libera a voz dentro de um gesto.
   */
  unlock() {
    if (this._unlocked || !this._synth || !this._Utterance) return;
    this._unlocked = true;
    if (this._job) return;
    try {
      const u = new this._Utterance(' ');
      u.volume = 0;
      this._synth.speak(u);
    } catch {
      // sem problema: a primeira fala normal tenta de novo
    }
  }

  /**
   * Fala o texto (dividido internamente em pedaços). Cancela a fala anterior, que resolve
   * 'cancelled'. Erros reais rejeitam a promessa (Error com .code) e emitem 'error'.
   * Com `lang` ('pt', 'en'...), se a voz escolhida não fala esse idioma, usa a melhor voz
   * do navegador para ele (pt-BR/en-US..., naturais/online primeiro). Sem voz para o
   * idioma, continua com a voz escolhida.
   * @param {string} text
   * @param {{ id?: any, lang?: string|null }} [options] id repassado nos eventos 'boundary'
   * @returns {Promise<'end'|'cancelled'>}
   */
  speak(text, { id = null, lang = null } = {}) {
    if (!this._synth || !this._Utterance) return Promise.reject(unsupportedError());

    const previous = this._job;
    if (previous) this._settle(previous, 'cancelled');
    const busy = this._hardCancel();

    const source = String(text ?? '');
    const cleaned = cleanForSpeech(source);
    const chunks = chunkText(cleaned, { maxLength: this._chunkLength() }).filter((c) => hasSpeech(c.text));
    if (!chunks.length) {
      this._stopTimers();
      this._setState('idle');
      return Promise.resolve('end');
    }

    const job = {
      id,
      lang: lang ? String(lang) : null,
      voiceId: this._voiceForLang(lang),
      source,
      cleaned,
      chunks,
      index: 0,
      from: 0, // offset dentro do pedaço de onde a fala (re)começa
      lastWord: 0, // offset dentro do pedaço da última palavra anunciada
      utterance: null,
      started: false,
      startedAt: 0,
      queuedAt: 0,
      retries: 0,
      idleTicks: 0,
      softPaused: false,
      done: false,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this._job = job;
    this._setState('speaking');
    this._startWatchdog();
    // Chrome às vezes descarta um speak() feito logo após cancel(): dá um respiro.
    if (busy) this._later(job, () => this._speakChunk(job), RESPEAK_DELAY_MS);
    else this._speakChunk(job);
    return promise;
  }

  pause() {
    const job = this._job;
    if (this._state !== 'speaking' || !job) return;
    this._stopKeepAlive();
    if (this._useSoftPause()) {
      job.softPaused = true;
      job.from = job.lastWord;
      this._detach(job);
      this._hardCancel();
    } else {
      try { this._synth.pause(); } catch { /* ignora */ }
    }
    this._setState('paused');
  }

  resume() {
    const job = this._job;
    if (this._state !== 'paused' || !job) return;
    this._setState('speaking');

    if (job.softPaused) {
      job.softPaused = false;
      job.retries = 0;
      this._speakChunk(job);
      return;
    }

    const u = job.utterance;
    try { this._synth.resume(); } catch { /* ignora */ }
    if (job.started) this._startKeepAlive();
    // Às vezes o navegador não retoma: se nada está tocando, fala de novo da palavra atual.
    this._later(job, () => {
      if (this._state !== 'speaking' || !u || job.utterance !== u) return;
      if (this._synth.speaking || this._synth.pending) return;
      this._respeakFromLastWord(job);
    }, RESUME_CHECK_MS);
  }

  /** Para tudo. A fala pendente resolve 'cancelled'. */
  cancel() {
    const job = this._job;
    if (job) this._settle(job, 'cancelled');
    this._hardCancel();
    this._stopTimers();
    this._setState('idle');
  }

  // ---- internos: vozes ----------------------------------------------------

  /** Id da voz a usar para o idioma (a escolhida, se ela fala o idioma). */
  _voiceForLang(lang) {
    if (!lang) return this._voiceId;
    const chosen = this._voices.find((v) => v.id === this._voiceId) || null;
    if (chosen && voiceSpeaks(chosen, lang)) return chosen.id;
    return pickVoiceForLang(this._voices, lang)?.id ?? this._voiceId;
  }

  /** Voz em uso pela fala atual (pode diferir da escolhida por causa do idioma). */
  _activeVoice() {
    const id = this._job?.voiceId ?? this._voiceId;
    return this._voices.find((v) => v.id === id) || null;
  }

  _listenVoices() {
    const handler = () => this._refreshVoices();
    if (typeof this._synth.addEventListener === 'function') {
      this._synth.addEventListener('voiceschanged', handler);
    } else {
      this._synth.onvoiceschanged = handler;
    }
  }

  _waitForVoices() {
    return new Promise((resolve) => {
      if (this._refreshVoices()) {
        resolve();
        return;
      }
      const startedAt = now();
      const finish = () => {
        clearInterval(timer);
        this._voicesReady = null;
        resolve();
      };
      const timer = setInterval(() => {
        if (this._refreshVoices() || now() - startedAt >= VOICES_TIMEOUT_MS) finish();
      }, VOICES_POLL_MS);
      this._voicesReady = finish;
    });
  }

  /** Relê a lista. Retorna true se há vozes. Emite 'voiceschanged' se mudou. */
  _refreshVoices() {
    let natives = [];
    try {
      natives = Array.from(this._synth.getVoices() || []);
    } catch {
      natives = [];
    }
    const native = new Map();
    for (const v of natives) {
      const id = voiceIdOf(v);
      if (id && !native.has(id)) native.set(id, v);
    }
    this._native = native;

    const voices = sortVoices(natives.map(normalizeVoice));
    const signature = voices.map((v) => `${v.id}|${v.lang}|${v.localService}`).join('\n');
    if (signature !== this._signature) {
      this._signature = signature;
      this._voices = voices;
      this._applyVoiceChoice();
      this.dispatchEvent(new CustomEvent('voiceschanged', { detail: { voices: this.getVoices() } }));
    }
    if (voices.length && this._voicesReady) this._voicesReady();
    return voices.length > 0;
  }

  /** Aplica a voz preferida se existir; senão mantém a atual ou escolhe a padrão. */
  _applyVoiceChoice() {
    if (!this._voices.length) return;
    if (this._preferredId && this._native.has(this._preferredId)) {
      this._voiceId = this._preferredId;
      return;
    }
    const currentOk = this._voiceId && this._native.has(this._voiceId);
    // não troca a voz automática no meio de uma fala
    if (currentOk && this._state !== 'idle') return;
    this._voiceId = pickDefaultVoice(this._voices)?.id ?? null;
  }

  // ---- internos: fala -----------------------------------------------------

  _validate(value, key, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(clamp(n, LIMITS[key]) * 100) / 100;
  }

  /** Pedaços menores em velocidade baixa (o corte de ~15 s do Chrome é por tempo). */
  _chunkLength() {
    if (this._rate >= 1) return this._maxChunk;
    return Math.max(80, Math.round(this._maxChunk * this._rate));
  }

  _useSoftPause() {
    if (this._pauseMode === 'soft') return true;
    if (this._pauseMode === 'native') return false;
    if (this._isAndroid) return true;
    const v = this._activeVoice();
    return this._isChromium && Boolean(v) && !v.localService;
  }

  _needsKeepAlive() {
    const v = this._activeVoice();
    return this._isChromium && !this._isAndroid && Boolean(v) && !v.localService;
  }

  _speakChunk(job) {
    if (this._job !== job || job.done || job.softPaused) return;
    const chunk = job.chunks[job.index];
    const from = Math.min(job.from, chunk.text.length);
    const spoken = chunk.text.slice(from);
    if (!hasSpeech(spoken)) {
      this._nextChunk(job);
      return;
    }
    const base = chunk.start + from;

    const u = new this._Utterance(spoken);
    const nativeVoice = this._native.get(job.voiceId) || this._native.get(this._voiceId) || null;
    if (nativeVoice) {
      u.voice = nativeVoice;
      u.lang = nativeVoice.lang || job.lang || 'pt-BR';
    } else {
      u.lang = job.lang || 'pt-BR';
    }
    u.rate = this._rate;
    u.pitch = this._pitch;
    u.volume = this._volume;

    u.onstart = () => {
      if (job.utterance === u) this._markStarted(job);
    };
    u.onboundary = (e) => {
      if (job.utterance === u) this._handleBoundary(job, chunk, base, e);
    };
    u.onend = () => {
      this._alive.delete(u);
      if (job.utterance === u) this._nextChunk(job);
    };
    u.onerror = (e) => {
      this._alive.delete(u);
      if (job.utterance === u) this._handleError(job, e);
    };

    job.utterance = u;
    job.started = false;
    job.queuedAt = now();
    job.idleTicks = 0;
    this._alive.add(u);
    try {
      this._synth.speak(u);
    } catch {
      this._handleError(job, { error: 'synthesis-failed' });
    }
  }

  _markStarted(job) {
    if (!job.started) {
      job.started = true;
      job.startedAt = now();
      job.idleTicks = 0;
    }
    if (this._state === 'speaking') this._startKeepAlive();
  }

  _handleBoundary(job, chunk, base, e) {
    if (e && e.name && e.name !== 'word') return;
    const local = Number(e?.charIndex);
    if (!Number.isFinite(local) || local < 0) return;
    this._markStarted(job); // alguns motores não disparam onstart
    const span = wordSpanAt(job.source, job.cleaned, base + local, Number(e?.charLength));
    if (!span || span.charIndex >= chunk.end) return;
    job.lastWord = Math.max(0, span.charIndex - chunk.start);
    this.dispatchEvent(new CustomEvent('boundary', {
      detail: { id: job.id, charIndex: span.charIndex, charLength: span.charLength },
    }));
  }

  _nextChunk(job) {
    if (job.done || this._job !== job) return;
    this._detach(job);
    job.index += 1;
    job.from = 0;
    job.lastWord = 0;
    job.retries = 0;
    if (job.index >= job.chunks.length) {
      this._finish(job, 'end');
      return;
    }
    this._speakChunk(job);
  }

  _handleError(job, e) {
    const code = String(e?.error || 'synthesis-failed');
    this._detach(job);

    if (IGNORABLE_ERRORS.has(code)) {
      // Ninguém aqui cancelou esta utterance. Se ela nem começou, é o bug do Chrome logo
      // depois de um cancel(): tenta de novo uma vez. Senão, foi cancelada por fora.
      if (!job.started && job.retries < 1) {
        job.retries += 1;
        this._later(job, () => this._speakChunk(job), RESPEAK_DELAY_MS);
      } else {
        this._finish(job, 'cancelled');
      }
      return;
    }

    if (code !== 'not-allowed' && job.retries < 1) {
      job.retries += 1;
      job.from = job.lastWord;
      this._hardCancel();
      this._later(job, () => this._speakChunk(job), RESPEAK_DELAY_MS * 3);
      return;
    }
    this._fail(job, code);
  }

  _respeakFromLastWord(job) {
    job.from = job.lastWord;
    this._detach(job);
    this._hardCancel();
    this._later(job, () => this._speakChunk(job), RESPEAK_DELAY_MS);
  }

  /** Solta a utterance atual do job (eventos atrasados dela passam a ser ignorados). */
  _detach(job) {
    const u = job.utterance;
    job.utterance = null;
    if (u) setTimeout(() => this._alive.delete(u), RELEASE_UTTERANCE_MS);
  }

  /** Resolve a promessa do job sem mexer no estado (quem chama decide). */
  _settle(job, result) {
    if (job.done) return;
    job.done = true;
    this._detach(job);
    if (this._job === job) this._job = null;
    job.resolve(result);
  }

  _finish(job, result) {
    const current = this._job === job;
    this._settle(job, result);
    if (current) {
      this._stopTimers();
      this._setState('idle');
    }
  }

  _fail(job, code) {
    if (job.done) return;
    const message = ERROR_MESSAGES[code] || DEFAULT_ERROR_MESSAGE;
    const current = this._job === job;
    job.done = true;
    this._detach(job);
    if (current) {
      this._job = null;
      this._hardCancel();
      this._stopTimers();
      this._setState('idle');
    }
    const err = new Error(message);
    err.code = code;
    this.dispatchEvent(new CustomEvent('error', { detail: { message, code } }));
    job.reject(err);
  }

  /** speechSynthesis.cancel() à prova de "travado". Retorna true se havia algo tocando. */
  _hardCancel() {
    const s = this._synth;
    let busy = false;
    try {
      busy = Boolean(s.speaking || s.pending);
      s.cancel();
      // Chrome: depois de cancelar em pausa, a próxima fala nasce pausada
      if (s.paused) s.resume();
    } catch {
      // ignora
    }
    return busy;
  }

  /** Executa fn depois de ms, só se o job ainda for o atual. */
  _later(job, fn, ms) {
    setTimeout(() => {
      if (this._job === job && !job.done) fn();
    }, ms);
  }

  _setState(state) {
    if (state === this._state) return;
    this._state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
  }

  // ---- internos: timers ---------------------------------------------------

  _startKeepAlive() {
    if (this._keepAlive || !this._needsKeepAlive()) return;
    // Chrome para vozes online depois de ~15 s; pause/resume periódico mantém a fala viva.
    this._keepAlive = setInterval(() => {
      const s = this._synth;
      if (this._state !== 'speaking' || !s.speaking || s.paused) return;
      try {
        s.pause();
        s.resume();
      } catch {
        // ignora
      }
    }, KEEP_ALIVE_MS);
  }

  _stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  _startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => this._tick(), WATCHDOG_MS);
  }

  _stopWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  _stopTimers() {
    this._stopKeepAlive();
    this._stopWatchdog();
  }

  /** Vigia: pedaço que não começa (Chrome travado) ou onend que nunca chega. */
  _tick() {
    const job = this._job;
    if (!job) {
      this._stopWatchdog();
      return;
    }
    if (this._state !== 'speaking' || !job.utterance) return;
    const s = this._synth;
    const t = now();

    if (!job.started) {
      if (s.speaking && !s.pending) {
        this._markStarted(job);
        return;
      }
      if (t - job.queuedAt < START_TIMEOUT_MS) return;
      if (job.retries < 1) {
        job.retries += 1;
        this._respeakFromLastWord(job);
      } else {
        this._fail(job, 'synthesis-failed');
      }
      return;
    }

    if (s.speaking || s.pending) {
      job.idleTicks = 0;
      return;
    }
    job.idleTicks += 1;
    const chunk = job.chunks[job.index];
    const remaining = chunk.text.length - job.from;
    const minMs = (remaining / (CHARS_PER_SECOND * this._rate)) * 1000 * 0.5;
    if (job.idleTicks >= LOST_END_TICKS && t - job.startedAt >= minMs) this._nextChunk(job);
  }
}
