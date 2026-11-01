// NeuralSpeechEngine: voz neural gerada pelo servidor local (POST /api/tts), com a mesma
// interface pública do SpeechEngine (voz do navegador).
//
// Fluidez (sem silêncio entre frases):
// - cache local dos áudios por (motor, voz, idioma, texto), com limite e revogação das
//   object URLs; pedidos iguais em andamento são compartilhados;
// - `prefetch()` gera o áudio antes da hora; quando fica pronto, um dos "decks" (elementos
//   <audio> reaproveitados) já carrega o arquivo, então o `speak()` seguinte começa na hora;
// - texto longo é dividido em pedaços (text-chunker) e o próximo pedaço é pedido enquanto o
//   atual toca.
// Outros cuidados:
// - cada fala é um "job"; eventos atrasados de jobs antigos são ignorados;
// - cancel() aborta os pedidos pendentes (o servidor tem uma fila só por GPU);
// - 503 (modelo carregando/ocupado) → espera e tenta de novo; pedido lento com o modelo ainda
//   não carregado → evento 'loadingmodel' para a interface avisar;
// - velocidade via playbackRate com preservesPitch (o tom não muda); 'boundary' estimado pelo
//   progresso do áudio, com peso pelo número de letras de cada palavra;
// - iOS/Safari só deixa tocar áudio em elementos "liberados" num toque: unlock() libera os decks.
//
// Eventos (CustomEvent):
//   'statechange'   { state }                      'idle' | 'speaking' | 'paused'
//   'boundary'      { id, charIndex, charLength }   offsets relativos ao texto passado ao speak
//   'error'         { message, code }
//   'voiceschanged' { voices }
//   'loadingmodel'  { engine, loading }             true: o servidor está carregando o modelo
//                                                   (1ª fala pode levar 10–30 s); false: pronto
//   'langfallback'  { requested, used }             o motor não fala `requested`; leu com `used`
//                                                   (uma vez até voltar a um idioma suportado)

import { chunkText, cleanForSpeech, hasSpeech, wordSpanAt } from './text-chunker.js';

/**
 * @typedef {{ id: string, name: string, lang: string, localService: boolean, isDefault: boolean,
 *   engine: string, gender: string|null, languages: string[] }} NeuralVoice
 */

const LIMITS = {
  rate: [0.5, 2.5],
  pitch: [0, 2],
  volume: [0, 1],
};

const MAX_CHUNK_LENGTH = 500; // o servidor aceita até 600
const CACHE_LIMIT = 12;
const DECK_COUNT = 3; // 1 tocando + 2 já carregados com as próximas frases
const PROBE_TIMEOUT_MS = 2500;
const JSON_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 120000; // a 1ª carga do modelo pode demorar
const SLOW_REQUEST_MS = 1500; // pedido mais lento que isso: confere se o modelo está carregando
const RETRY_DELAYS_MS = [1500, 2500, 4000, 6000, 8000, 10000]; // ~32 s esperando um 503
const TICK_MS = 40;
const LOST_ENDED_MS = 400;

// Pesos para estimar o tempo de cada palavra (unidades ≈ letras).
const WORD_ONSET = 1;
const DIGIT_WEIGHT = 2.2; // "1999" fala bem mais que 4 letras
const PAUSE_WEIGHT = { strong: 4, medium: 2 };
const STRONG_PUNCT_RE = /[.!?…]["'”’»)\]]*$/;
const MEDIUM_PUNCT_RE = /[,;:—–]["'”’»)\]]*$/;

const MESSAGES = {
  SERVER_UNREACHABLE: 'O servidor de voz não respondeu. Ele está aberto?',
  TIMEOUT: 'O servidor de voz demorou demais para responder. Tente de novo.',
  ENGINE_UNAVAILABLE: 'A voz de IA não está disponível agora. Tente de novo em instantes ou use a voz do navegador.',
  BAD_REQUEST: 'O servidor de voz recusou este trecho.',
  UNSUPPORTED: 'Esta voz não fala o idioma deste trecho. Escolha outra voz.',
  SERVER_ERROR: 'O servidor de voz teve um erro ao gerar o áudio. Tente de novo.',
  AUDIO_EMPTY: 'O servidor de voz devolveu um áudio vazio.',
  AUDIO_PLAYBACK: 'Não foi possível tocar o áudio gerado pela voz de IA.',
  'not-allowed': 'O navegador só libera o som depois de um toque ou clique na página. Toque em Play para começar.',
  ABORTED: 'Pedido de voz cancelado.',
};

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, value));
}

function makeError(code, message, extra = {}) {
  const err = new Error(message || MESSAGES[code] || MESSAGES.SERVER_ERROR);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}${path}`;
}

function langBase(lang) {
  return String(lang || '').trim().toLowerCase().replace(/_/g, '-').split('-')[0];
}

/** setTimeout que acorda cedo (rejeitando) se o sinal abortar. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeError('ABORTED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeError('ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** fetch com tempo limite e sinal externo. Rejeita com .code TIMEOUT/ABORTED/SERVER_UNREACHABLE. */
async function timedFetch(fetchImpl, url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    if (outerSignal?.aborted) throw makeError('ABORTED');
    if (timedOut) throw makeError('TIMEOUT');
    throw makeError('SERVER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Lê o corpo de erro { error, code } do servidor (sem confiar no formato). */
async function readServerError(res) {
  try {
    const data = await res.json();
    const message = typeof data?.error === 'string' ? data.error.slice(0, 300) : '';
    const code = typeof data?.code === 'string' ? data.code.slice(0, 60) : '';
    return { message, code };
  } catch {
    return { message: '', code: '' };
  }
}

function httpError(status, { message, code }) {
  if (status === 400 || status === 413) return makeError(code || 'BAD_REQUEST', message || MESSAGES.BAD_REQUEST, { status });
  if (status === 422) return makeError(code || 'UNSUPPORTED', message || MESSAGES.UNSUPPORTED, { status });
  if (status === 503) return makeError(code || 'ENGINE_UNAVAILABLE', message || MESSAGES.ENGINE_UNAVAILABLE, { status });
  if (status === 404) return makeError('SERVER_UNREACHABLE', MESSAGES.SERVER_UNREACHABLE, { status });
  return makeError(code || 'SERVER_ERROR', message || MESSAGES.SERVER_ERROR, { status });
}

/** WAV mudo bem curto (para liberar os <audio> no iOS dentro do toque). */
function silentWavDataUrl() {
  const rate = 8000;
  const samples = 400; // 50 ms
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples * 2, true);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/**
 * Palavras de um pedaço com o peso (tempo relativo) de cada uma.
 * Offsets em relação ao texto inteiro passado ao speak.
 */
function weighWords(source, cleaned, chunk) {
  const words = [];
  let total = 0;
  const re = /\S+/g;
  let m;
  while ((m = re.exec(chunk.text))) {
    const token = m[0];
    const letters = (token.match(/\p{L}|\p{M}/gu) || []).length;
    const digits = (token.match(/\p{N}/gu) || []).length;
    let pause = 0;
    if (STRONG_PUNCT_RE.test(token)) pause = PAUSE_WEIGHT.strong;
    else if (MEDIUM_PUNCT_RE.test(token)) pause = PAUSE_WEIGHT.medium;
    if (!letters && !digits) {
      // só pontuação/símbolo: vira pausa da palavra anterior
      if (words.length) {
        words[words.length - 1].weight += pause;
        total += pause;
      }
      continue;
    }
    const span = wordSpanAt(source, cleaned, chunk.start + m.index);
    if (!span) continue;
    const weight = WORD_ONSET + letters + digits * DIGIT_WEIGHT + pause;
    words.push({ charIndex: span.charIndex, charLength: span.charLength, from: total, weight });
    total += weight;
  }
  for (const w of words) {
    w.from /= total || 1;
    w.weight /= total || 1;
  }
  return words;
}

export class NeuralSpeechEngine extends EventTarget {
  /** true se o navegador tem o necessário (fetch, <audio>, Blob URLs). */
  static isSupported() {
    return typeof globalThis.fetch === 'function'
      && typeof globalThis.Audio === 'function'
      && typeof globalThis.URL?.createObjectURL === 'function';
  }

  /**
   * Consulta GET /api/tts/status com tempo curto. Não lança erro.
   * @param {string} [baseUrl] '' = mesma origem do site
   * @param {{ timeout?: number }} [options]
   * @returns {Promise<object|null>} o status do servidor ({ ok, device, engines... }) ou null
   */
  static async probe(baseUrl = '', { timeout = PROBE_TIMEOUT_MS, fetch: fetchImpl } = {}) {
    const f = fetchImpl || globalThis.fetch?.bind(globalThis);
    if (!f) return null;
    try {
      const res = await timedFetch(f, joinUrl(baseUrl, '/api/tts/status'), { cache: 'no-store' }, timeout);
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] '' = mesma origem do site
   * @param {typeof fetch} [options.fetch] para testes
   * @param {() => HTMLAudioElement} [options.createAudio] para testes
   * @param {number} [options.cacheLimit] áudios guardados no cache local
   * @param {number} [options.maxChunkLength] tamanho máximo de cada pedido ao servidor
   */
  constructor({
    baseUrl = '',
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    createAudio = () => new Audio(),
    cacheLimit = CACHE_LIMIT,
    maxChunkLength = MAX_CHUNK_LENGTH,
  } = {}) {
    super();
    this._baseUrl = baseUrl;
    this._fetch = fetchImpl;
    this._createAudio = createAudio;
    this._cacheLimit = Math.max(2, cacheLimit);
    this._maxChunk = Math.min(MAX_CHUNK_LENGTH, Math.max(80, maxChunkLength));

    this._status = null;
    /** @type {NeuralVoice[]} */
    this._voices = [];
    this._signature = '';
    this._voiceId = null;
    this._preferredId = null;

    this._rate = 1;
    this._pitch = 1;
    this._volume = 1;

    this._state = 'idle';
    this._job = null;
    /** @type {Map<string, object>} chave → entrada (ordem = uso mais antigo primeiro) */
    this._cache = new Map();
    this._decks = [];
    this._unlocked = false;
    this._ticker = null;
    this._modelLoading = false;
    this._loadingEngine = null;
    this._checkingLoad = false;
    this._lastFallback = null;
  }

  // ---- identificação ------------------------------------------------------

  /** 'neural' (o SpeechEngine devolve 'browser'). */
  get kind() {
    return 'neural';
  }

  /** O tom não é ajustável na voz neural (a velocidade mantém o tom original). */
  get supportsPitch() {
    return false;
  }

  /** Último status recebido do servidor (init/probe interno) ou null. */
  get status() {
    return this._status;
  }

  /** true enquanto o servidor está carregando o modelo (ver evento 'loadingmodel'). */
  get modelLoading() {
    return this._modelLoading;
  }

  /** Idiomas que os motores disponíveis falam (ex.: ['pt','en','es',...]); vazio se desconhecido. */
  get languages() {
    return [...(this._supportedLangs() || [])];
  }

  // ---- vozes --------------------------------------------------------------

  /**
   * Busca o status e as vozes do servidor. Pode ser chamado de novo para atualizar.
   * Rejeita (Error com .code 'SERVER_UNREACHABLE') se o servidor não responder.
   * @param {{ preferredVoiceId?: string|null }} [options]
   * @returns {Promise<NeuralVoice[]>}
   */
  async init({ preferredVoiceId = null } = {}) {
    if (preferredVoiceId) this._preferredId = String(preferredVoiceId);
    const [status, voices] = await Promise.all([
      this._getJson('/api/tts/status'),
      this._getJson('/api/tts/voices'),
    ]);
    this._status = status && typeof status === 'object' ? status : null;
    this._setVoices(Array.isArray(voices?.voices) ? voices.voices : []);
    this._applyVoiceChoice();
    return this.getVoices();
  }

  /** Vozes (pt primeiro). Campos do Voice comum + engine, gender, languages. */
  getVoices() {
    return this._voices.map((v) => ({ ...v, languages: [...v.languages] }));
  }

  get voiceId() {
    return this._voiceId;
  }

  /** Voz atual ou null. */
  get voice() {
    const v = this._voices.find((item) => item.id === this._voiceId);
    return v ? { ...v, languages: [...v.languages] } : null;
  }

  /**
   * Escolhe a voz pelo id ('kokoro:pf_dora'). Vale a partir da próxima fala. Retorna false se a
   * voz não existe (a escolha fica guardada para quando a lista chegar).
   */
  setVoice(id) {
    if (!id) {
      this._preferredId = null;
      this._voiceId = this._pickDefaultVoice()?.id ?? null;
      return true;
    }
    this._preferredId = String(id);
    if (!this._voices.length) return true;
    if (!this._voices.some((v) => v.id === this._preferredId)) return false;
    this._voiceId = this._preferredId;
    return true;
  }

  // ---- ajustes ------------------------------------------------------------

  get rate() { return this._rate; }
  set rate(v) {
    this._rate = this._validate(v, 'rate', this._rate);
    this._applyAudioSettings();
  }

  /** Guardado só por compatibilidade: a voz neural ignora o tom (supportsPitch = false). */
  get pitch() { return this._pitch; }
  set pitch(v) { this._pitch = this._validate(v, 'pitch', this._pitch); }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = this._validate(v, 'volume', this._volume);
    this._applyAudioSettings();
  }

  /** 'idle' | 'speaking' | 'paused'. Enquanto o áudio é gerado, o estado já é 'speaking'. */
  get state() {
    return this._state;
  }

  // ---- fala ---------------------------------------------------------------

  /**
   * Chame de forma síncrona dentro de um toque/clique (ex.: no Play) antes da primeira fala:
   * no iOS/Safari libera os elementos de áudio tocando um som mudo.
   */
  unlock() {
    if (this._unlocked || typeof globalThis.btoa !== 'function') return;
    this._unlocked = true;
    const silent = silentWavDataUrl();
    for (const deck of this._getDecks()) {
      if (deck.role !== 'idle') continue;
      try {
        const el = deck.el;
        el.src = silent;
        deck.url = null;
        const p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(() => { if (deck.role === 'idle' && !deck.url) el.pause(); }).catch(() => {});
        }
      } catch {
        // sem problema: a primeira fala normal tenta de novo
      }
    }
  }

  /**
   * Fala o texto. Cancela a fala anterior (que resolve 'cancelled'). Erros rejeitam a
   * promessa (Error com .code e mensagem pt-BR) e emitem 'error'.
   * @param {string} text
   * @param {{ id?: any, lang?: string|null }} [options] id repassado nos eventos 'boundary';
   *   lang 'pt'|'en'|... (sem lang: o idioma da voz escolhida)
   * @returns {Promise<'end'|'cancelled'>}
   */
  speak(text, { id = null, lang = null } = {}) {
    const previous = this._job;
    if (previous) this._settle(previous, 'cancelled');
    this._stopPlayback();

    const source = String(text ?? '');
    const cleaned = cleanForSpeech(source);
    const chunks = chunkText(cleaned, { maxLength: this._maxChunk }).filter((c) => hasSpeech(c.text));
    if (!chunks.length) {
      this._setState('idle');
      return Promise.resolve('end');
    }

    const job = {
      id,
      source,
      cleaned,
      lang: this._resolveLang(lang, true),
      chunks: chunks.map((c) => ({ ...c, entry: null, words: null })),
      index: 0,
      deck: null,
      started: false, // o áudio do pedaço atual já começou a tocar
      paused: false,
      wordIdx: -1,
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
    // pede os dois primeiros pedaços já (na ordem: o servidor atende um por vez)
    this._ensureEntry(job, 0);
    this._ensureEntry(job, 1);
    this._playChunk(job);
    return promise;
  }

  /**
   * Gera o áudio e guarda no cache local, sem tocar. Pedidos repetidos são ignorados.
   * Nunca rejeita: resolve true quando o áudio está pronto, false se falhou/foi cancelado.
   * @param {string} text
   * @param {{ lang?: string|null }} [options]
   * @returns {Promise<boolean>}
   */
  prefetch(text, { lang = null } = {}) {
    const cleaned = cleanForSpeech(String(text ?? ''));
    const chunks = chunkText(cleaned, { maxLength: this._maxChunk }).filter((c) => hasSpeech(c.text));
    if (!chunks.length) return Promise.resolve(true);
    const useLang = this._resolveLang(lang, false);
    // os dois primeiros pedaços bastam; o resto é pedido enquanto toca
    const entries = chunks.slice(0, 2).map((c) => this._getEntry(c.text, useLang));
    return Promise.all(entries.map((e) => e.promise)).then(() => true, () => false);
  }

  pause() {
    const job = this._job;
    if (this._state !== 'speaking' || !job) return;
    job.paused = true;
    if (job.deck) {
      try { job.deck.el.pause(); } catch { /* ignora */ }
    }
    this._stopTicker();
    this._setState('paused');
  }

  resume() {
    const job = this._job;
    if (this._state !== 'paused' || !job) return;
    job.paused = false;
    this._setState('speaking');
    if (job.deck) {
      this._play(job, job.deck);
      this._startTicker(job);
    } else if (job.chunks[job.index].entry?.status === 'ready') {
      this._startAudio(job);
    }
    // senão o áudio ainda está sendo gerado: _playChunk começa quando chegar
  }

  /** Para tudo e aborta os pedidos pendentes. A fala atual resolve 'cancelled'. */
  cancel() {
    const job = this._job;
    if (job) this._settle(job, 'cancelled');
    this._stopPlayback();
    this._abortPending();
    this._setModelLoading(false);
    this._setState('idle');
  }

  /** Libera tudo (áudios em cache, elementos <audio>). O engine não deve ser usado depois. */
  dispose() {
    this.cancel();
    for (const entry of this._cache.values()) this._dropEntry(entry);
    this._cache.clear();
    for (const deck of this._decks) this._resetDeck(deck);
    this._decks = [];
  }

  // ---- internos: servidor -------------------------------------------------

  async _getJson(path) {
    if (!this._fetch) throw makeError('SERVER_UNREACHABLE');
    const res = await timedFetch(this._fetch, joinUrl(this._baseUrl, path), { cache: 'no-store' }, JSON_TIMEOUT_MS);
    if (!res.ok) throw httpError(res.status, await readServerError(res));
    try {
      return await res.json();
    } catch {
      throw makeError('SERVER_ERROR');
    }
  }

  /** Entrada do cache para (voz, idioma, texto); cria e dispara o pedido se não existir. */
  _getEntry(text, lang) {
    const { voice, engine } = this._resolveVoice(lang);
    const key = `${engine || ''}|${voice || ''}|${lang}|${text}`;
    const existing = this._cache.get(key);
    if (existing) {
      this._cache.delete(key);
      this._cache.set(key, existing); // uso mais recente vai para o fim
      return existing;
    }
    const entry = {
      key,
      text,
      lang,
      voice,
      engine,
      status: 'pending',
      controller: new AbortController(),
      url: null,
      duration: 0,
      pins: 0,
      promise: null,
    };
    entry.promise = this._fetchAudio(entry).then(() => {
      entry.status = 'ready';
      if (this._cache.get(key) !== entry) {
        this._dropEntry(entry); // saiu do cache enquanto baixava
        return;
      }
      this._primeDeck(entry);
      this._trimCache();
    }, (err) => {
      entry.status = 'error';
      if (this._cache.get(key) === entry) this._cache.delete(key);
      throw err;
    });
    entry.promise.catch(() => {}); // quem precisa do erro trata no próprio await
    this._cache.set(key, entry);
    this._trimCache();
    return entry;
  }

  async _fetchAudio(entry) {
    const signal = entry.controller.signal;
    const body = { text: entry.text, lang: entry.lang };
    if (entry.voice) body.voice = entry.voice;
    if (entry.engine) body.engine = entry.engine;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };

    for (let attempt = 0; ; attempt += 1) {
      if (!this._fetch) throw makeError('SERVER_UNREACHABLE');
      const slowTimer = setTimeout(() => this._checkModelLoading(entry.engine), SLOW_REQUEST_MS);
      let res;
      try {
        res = await timedFetch(this._fetch, joinUrl(this._baseUrl, '/api/tts'), init, REQUEST_TIMEOUT_MS, signal);
      } finally {
        clearTimeout(slowTimer);
      }

      if (res.ok) {
        let blob;
        try {
          blob = await res.blob();
        } catch {
          if (signal.aborted) throw makeError('ABORTED');
          throw makeError('SERVER_UNREACHABLE');
        }
        if (signal.aborted) throw makeError('ABORTED');
        if (!blob || !blob.size) throw makeError('AUDIO_EMPTY');
        entry.duration = Number.parseFloat(res.headers.get('X-Audio-Duration')) || 0;
        entry.url = URL.createObjectURL(blob);
        this._setModelLoading(false);
        return;
      }

      const info = await readServerError(res);
      if (res.status === 503 && attempt < RETRY_DELAYS_MS.length) {
        // 503: motor carregando/ocupado. Se o status diz que ele nem está instalado, desiste já.
        const status = await NeuralSpeechEngine.probe(this._baseUrl, { fetch: this._fetch });
        if (signal.aborted) throw makeError('ABORTED');
        if (status) this._status = status;
        const eng = this._engineStatus(entry.engine, status);
        if (status && eng && eng.available === false) {
          throw makeError(info.code || 'ENGINE_UNAVAILABLE', eng.error || info.message || MESSAGES.ENGINE_UNAVAILABLE, { status: 503 });
        }
        this._setModelLoading(true, entry.engine || eng?.id || status?.defaultEngine || null);
        await wait(RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      throw httpError(res.status, info);
    }
  }

  _engineStatus(engineId, status = this._status) {
    const engines = Array.isArray(status?.engines) ? status.engines : [];
    const id = engineId || status?.defaultEngine;
    return engines.find((e) => e && e.id === id) || null;
  }

  /** Pedido demorando: se o modelo ainda não está carregado, avisa 'loadingmodel'. */
  async _checkModelLoading(engineId) {
    if (this._modelLoading || this._checkingLoad) return;
    this._checkingLoad = true;
    try {
      const status = await NeuralSpeechEngine.probe(this._baseUrl, { fetch: this._fetch });
      if (!status) return;
      this._status = status;
      const eng = this._engineStatus(engineId, status);
      if (eng && eng.loaded === false && this._hasPending()) {
        this._setModelLoading(true, eng.id);
      }
    } finally {
      this._checkingLoad = false;
    }
  }

  _hasPending() {
    for (const e of this._cache.values()) if (e.status === 'pending') return true;
    return false;
  }

  _setModelLoading(loading, engine = this._loadingEngine) {
    if (loading === this._modelLoading) return;
    this._modelLoading = loading;
    this._loadingEngine = loading ? engine : null;
    this.dispatchEvent(new CustomEvent('loadingmodel', {
      detail: { engine: engine || this._status?.defaultEngine || null, loading },
    }));
  }

  _abortPending() {
    for (const [key, entry] of [...this._cache]) {
      if (entry.status !== 'pending') continue;
      this._cache.delete(key);
      entry.controller.abort();
    }
  }

  /** Mantém o cache no limite, descartando os prontos mais antigos que ninguém está usando. */
  _trimCache() {
    if (this._cache.size <= this._cacheLimit) return;
    for (const [key, entry] of this._cache) {
      if (this._cache.size <= this._cacheLimit) break;
      if (entry.status !== 'ready' || entry.pins > 0) continue;
      this._cache.delete(key);
      this._dropEntry(entry);
    }
  }

  _dropEntry(entry) {
    if (entry.status === 'pending') entry.controller.abort();
    if (!entry.url) return;
    for (const deck of this._decks) {
      if (deck.url === entry.url && deck.role !== 'playing') this._resetDeck(deck);
    }
    try { URL.revokeObjectURL(entry.url); } catch { /* ignora */ }
    entry.url = null;
  }

  // ---- internos: vozes e idiomas -----------------------------------------

  _setVoices(raw) {
    const voices = [];
    const seen = new Set();
    for (const v of raw) {
      if (!v || typeof v.id !== 'string' || !v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      const languages = (Array.isArray(v.languages) ? v.languages : [v.lang])
        .map(langBase)
        .filter(Boolean);
      voices.push({
        id: v.id,
        name: String(v.name || v.id),
        lang: languages[0] || '',
        localService: true,
        isDefault: Boolean(v.default),
        engine: String(v.engine || v.id.split(':')[0] || ''),
        gender: v.gender === 'f' || v.gender === 'm' ? v.gender : null,
        languages,
      });
    }
    const home = this._homeLang();
    const rank = (v) => (v.languages[0] === home ? 0 : v.languages.includes(home) ? 1 : 2);
    voices.sort((a, b) => rank(a) - rank(b)
      || a.lang.localeCompare(b.lang)
      || Number(b.isDefault) - Number(a.isDefault)
      || a.name.localeCompare(b.name, 'pt-BR'));

    const signature = voices.map((v) => `${v.id}|${v.languages.join(',')}`).join('\n');
    if (signature === this._signature) return;
    this._signature = signature;
    this._voices = voices;
    this._applyVoiceChoice();
    this.dispatchEvent(new CustomEvent('voiceschanged', { detail: { voices: this.getVoices() } }));
  }

  /** Idioma "da casa": o do navegador se houver voz para ele, senão pt. */
  _homeLang() {
    const nav = langBase(globalThis.navigator?.language);
    return nav || 'pt';
  }

  _pickDefaultVoice() {
    const home = this._homeLang();
    const speaks = (v, l) => v.languages.includes(l);
    return this._voices.find((v) => v.isDefault && speaks(v, home))
      || this._voices.find((v) => speaks(v, home))
      || this._voices.find((v) => v.isDefault && speaks(v, 'pt'))
      || this._voices.find((v) => speaks(v, 'pt'))
      || this._voices.find((v) => v.isDefault)
      || this._voices[0]
      || null;
  }

  _applyVoiceChoice() {
    if (!this._voices.length) return;
    if (this._preferredId && this._voices.some((v) => v.id === this._preferredId)) {
      this._voiceId = this._preferredId;
      return;
    }
    if (this._voiceId && this._voices.some((v) => v.id === this._voiceId)) return;
    this._voiceId = this._pickDefaultVoice()?.id ?? null;
  }

  /** Conjunto de idiomas dos motores disponíveis, ou null se ainda não se sabe. */
  _supportedLangs() {
    const set = new Set();
    const engines = Array.isArray(this._status?.engines) ? this._status.engines : [];
    for (const e of engines) {
      if (e && e.available !== false && Array.isArray(e.languages)) e.languages.forEach((l) => set.add(langBase(l)));
    }
    for (const v of this._voices) v.languages.forEach((l) => set.add(l));
    return set.size ? set : null;
  }

  /**
   * Idioma que será pedido ao servidor. Sem lang: o da voz escolhida. Idioma que nenhum
   * motor fala: o da voz escolhida (e avisa 'langfallback' quando `notify`).
   */
  _resolveLang(lang, notify) {
    const supported = this._supportedLangs();
    const chosen = this._voices.find((v) => v.id === this._voiceId);
    const own = chosen?.languages[0] || (supported?.has('pt') ? 'pt' : supported ? [...supported][0] : 'pt');
    const base = langBase(lang);
    if (!base) return own;
    if (!supported || supported.has(base)) {
      if (notify) this._lastFallback = null;
      return base;
    }
    // avisa uma vez por sequência (um documento inteiro em alemão não gera um aviso por frase)
    if (notify && this._lastFallback !== base) {
      this._lastFallback = base;
      this.dispatchEvent(new CustomEvent('langfallback', { detail: { requested: base, used: own } }));
    }
    return own;
  }

  /** Voz para o idioma: a escolhida se ela fala; senão a padrão do idioma (mesmo motor de preferência). */
  _resolveVoice(lang) {
    const chosen = this._voices.find((v) => v.id === this._voiceId) || null;
    if (chosen && chosen.languages.includes(lang)) return { voice: chosen.id, engine: chosen.engine };
    const speaks = this._voices.filter((v) => v.languages.includes(lang));
    const sameEngine = chosen ? speaks.filter((v) => v.engine === chosen.engine) : [];
    const pool = sameEngine.length ? sameEngine : speaks;
    const alt = pool.find((v) => v.isDefault) || pool.find((v) => v.gender && v.gender === chosen?.gender) || pool[0];
    if (alt) return { voice: alt.id, engine: alt.engine };
    // ninguém da lista fala: deixa o servidor escolher a padrão do idioma
    return { voice: null, engine: chosen?.engine || null };
  }

  // ---- internos: reprodução ----------------------------------------------

  _ensureEntry(job, index) {
    const chunk = job.chunks[index];
    if (!chunk || chunk.entry) return;
    chunk.entry = this._getEntry(chunk.text, job.lang);
    chunk.entry.pins += 1;
  }

  async _playChunk(job) {
    const chunk = job.chunks[job.index];
    const entry = chunk.entry;
    if (entry.status !== 'ready') {
      try {
        await entry.promise;
      } catch (err) {
        if (this._job !== job || job.done) return;
        this._fail(job, err);
        return;
      }
      if (this._job !== job || job.done) return;
      if (!entry.url) {
        this._fail(job, makeError('AUDIO_EMPTY'));
        return;
      }
    }
    this._ensureEntry(job, job.index + 1); // o próximo pedaço é gerado enquanto este toca
    if (job.paused) return; // resume() começa
    this._startAudio(job);
  }

  _startAudio(job) {
    const chunk = job.chunks[job.index];
    const url = chunk.entry.url;
    const deck = this._takeDeck(url);
    const el = deck.el;
    deck.role = 'playing';
    deck.job = job;
    if (deck.url !== url) {
      deck.url = url;
      el.src = url;
    } else if (el.currentTime || el.ended) {
      // mesmo áudio de novo (frase repetida, pedaços iguais): volta ao começo
      try { el.currentTime = 0; } catch { /* ignora */ }
    }
    job.deck = deck;
    job.started = false;
    job.endedAt = 0;
    job.wordIdx = -1;

    const mine = () => this._job === job && job.deck === deck && !job.done;
    el.onplaying = () => {
      if (mine()) job.started = true;
    };
    el.onended = () => {
      // el.ended confere que não é um 'ended' atrasado do uso anterior deste mesmo <audio>
      if (mine() && el.ended) this._onChunkEnd(job);
    };
    el.onerror = () => {
      if (mine()) this._fail(job, makeError('AUDIO_PLAYBACK'));
    };
    el.ontimeupdate = () => {
      if (mine()) this._tick(job);
    };
    this._applyAudioSettings();
    this._play(job, deck);
    this._startTicker(job);
  }

  _play(job, deck) {
    let p;
    try {
      p = deck.el.play();
    } catch {
      this._fail(job, makeError('AUDIO_PLAYBACK'));
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (this._job !== job || job.deck !== deck || job.done) return;
        if (err?.name === 'AbortError') return; // pause() logo depois do play()
        if (err?.name === 'NotAllowedError') {
          // sem gesto do usuário: fica pausado, como o SpeechEngine com 'not-allowed'
          this._fail(job, makeError('not-allowed'));
          return;
        }
        this._fail(job, makeError('AUDIO_PLAYBACK'));
      });
    }
  }

  _onChunkEnd(job) {
    this._releaseDeck(job);
    this._stopTicker();
    job.index += 1;
    if (job.index >= job.chunks.length) {
      this._finish(job);
      return;
    }
    this._playChunk(job);
  }

  _finish(job) {
    const current = this._job === job;
    this._settle(job, 'end');
    if (current) this._setState('idle');
  }

  /** Encerra o job (solta o cache e o deixa de ser o atual) sem resolver a promessa. */
  _close(job) {
    job.done = true;
    for (const c of job.chunks) {
      if (c.entry) c.entry.pins = Math.max(0, c.entry.pins - 1);
    }
    if (this._job === job) this._job = null;
    this._trimCache();
  }

  _settle(job, result) {
    if (job.done) return;
    this._close(job);
    job.resolve(result);
  }

  _fail(job, err) {
    if (job.done) return;
    const current = this._job === job;
    this._close(job);
    if (current) {
      this._stopPlayback();
      this._setState('idle');
    }
    const error = err instanceof Error ? err : makeError('SERVER_ERROR');
    if (!error.code) error.code = 'SERVER_ERROR';
    this.dispatchEvent(new CustomEvent('error', { detail: { message: error.message, code: error.code } }));
    job.reject(error);
  }

  // ---- internos: decks (<audio>) ------------------------------------------

  _getDecks() {
    while (this._decks.length < DECK_COUNT) {
      const el = this._createAudio();
      el.preload = 'auto';
      this._setPreservesPitch(el);
      this._decks.push({ el, url: null, role: 'idle', job: null, usedAt: 0 });
    }
    return this._decks;
  }

  _setPreservesPitch(el) {
    try {
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
    } catch {
      // ignora
    }
  }

  /** Deck para tocar `url`: o que já carregou esse áudio, senão um livre, senão o mais antigo. */
  _takeDeck(url) {
    const decks = this._getDecks().filter((d) => d.role !== 'playing');
    const ready = decks.find((d) => d.url === url);
    const pick = ready
      || decks.find((d) => d.role === 'idle' && !d.url)
      || decks.find((d) => d.role === 'idle')
      || decks.sort((a, b) => a.usedAt - b.usedAt)[0]
      || this._getDecks()[0];
    pick.usedAt = Date.now();
    return pick;
  }

  /** Áudio pré-carregado: deixa um deck livre já com o arquivo (o play começa sem espera). */
  _primeDeck(entry) {
    if (!entry.url || typeof globalThis.document === 'undefined') return;
    const decks = this._getDecks();
    if (decks.some((d) => d.url === entry.url)) return;
    const free = decks.filter((d) => d.role !== 'playing');
    const deck = free.find((d) => d.role === 'idle' && !d.url)
      || free.find((d) => d.role === 'idle')
      || free.sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!deck) return;
    deck.role = 'primed';
    deck.url = entry.url;
    deck.usedAt = Date.now();
    try {
      deck.el.src = entry.url;
      deck.el.load();
    } catch {
      this._resetDeck(deck);
    }
  }

  _releaseDeck(job) {
    const deck = job.deck;
    job.deck = null;
    if (!deck) return;
    deck.job = null;
    deck.role = 'idle';
    deck.el.onended = null;
    deck.el.onerror = null;
    deck.el.ontimeupdate = null;
    deck.el.onplaying = null;
    try { deck.el.pause(); } catch { /* ignora */ }
  }

  _resetDeck(deck) {
    deck.role = 'idle';
    deck.job = null;
    deck.url = null;
    try {
      deck.el.onended = null;
      deck.el.onerror = null;
      deck.el.ontimeupdate = null;
      deck.el.onplaying = null;
      deck.el.pause();
      deck.el.removeAttribute('src');
      deck.el.load();
    } catch {
      // ignora
    }
  }

  /** Para o áudio que estiver tocando (os decks pré-carregados continuam prontos). */
  _stopPlayback() {
    this._stopTicker();
    for (const deck of this._decks) {
      if (deck.role !== 'playing') continue;
      if (deck.job) deck.job.deck = null;
      deck.job = null;
      deck.role = 'idle';
      deck.el.onended = null;
      deck.el.onerror = null;
      deck.el.ontimeupdate = null;
      deck.el.onplaying = null;
      try {
        deck.el.pause();
        deck.el.currentTime = 0;
      } catch {
        // ignora
      }
    }
  }

  _applyAudioSettings() {
    for (const deck of this._decks) {
      try {
        deck.el.defaultPlaybackRate = this._rate;
        deck.el.playbackRate = this._rate;
        deck.el.volume = this._volume;
        this._setPreservesPitch(deck.el);
      } catch {
        // ignora
      }
    }
  }

  // ---- internos: palavra atual (boundary estimado) ------------------------

  _startTicker(job) {
    this._stopTicker();
    this._ticker = setInterval(() => this._tick(job), TICK_MS);
  }

  _stopTicker() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = null;
  }

  _tick(job) {
    if (this._job !== job || job.done || !job.deck || job.paused) return;
    const el = job.deck.el;
    const chunk = job.chunks[job.index];
    // 'ended' perdido (raro): se o áudio continua terminado um tempo sem o evento, segue em
    // frente. Não antecipa o evento: ele ainda está na fila e pegaria o próximo uso do deck.
    if (job.started && el.ended) {
      job.endedAt ||= Date.now();
      if (Date.now() - job.endedAt >= LOST_ENDED_MS) this._onChunkEnd(job);
      return;
    }
    job.endedAt = 0;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : chunk.entry.duration;
    if (!duration) return;
    if (!chunk.words) chunk.words = weighWords(job.source, job.cleaned, chunk);
    const words = chunk.words;
    if (!words.length) return;
    const pos = Math.min(1, Math.max(0, el.currentTime / duration));
    let i = Math.max(0, job.wordIdx);
    while (i + 1 < words.length && words[i + 1].from <= pos) i += 1;
    if (i <= job.wordIdx) return;
    if (job.wordIdx < 0 && !el.currentTime) return; // ainda não começou
    job.wordIdx = i;
    const w = words[i];
    this.dispatchEvent(new CustomEvent('boundary', {
      detail: { id: job.id, charIndex: w.charIndex, charLength: w.charLength },
    }));
  }

  // ---- internos: utilidades ----------------------------------------------

  _validate(value, key, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(clamp(n, LIMITS[key]) * 100) / 100;
  }

  _setState(state) {
    if (state === this._state) return;
    this._state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
  }
}
