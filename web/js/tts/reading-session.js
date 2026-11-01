// ReadingSession: lê o documento frase a frase, atravessando páginas.
// Cada comando (start, next, previous, restartCurrent, stop) aumenta um contador de
// geração; laços e operações antigas conferem a geração e saem sem efeito colateral.
// Comandos que precisam carregar páginas passam por uma fila, então cliques rápidos
// (ex.: "próxima" 3 vezes) se acumulam na ordem certa.
//
// Idioma (versão 2): cada página tem o idioma detectado pelo texto dela (com o idioma da
// página anterior como desempate/fallback); frases longas com idioma claramente diferente
// usam o próprio. O idioma vai em `engine.speak(texto, { id, lang })`. `setLanguage('en')`
// fixa um idioma; `setLanguage('auto')` volta à detecção.
// Pré-carregamento: enquanto fala uma frase, pede `engine.prefetch(texto, { lang })` das
// próximas 2 (atravessando páginas), uma vez só por frase. Só se o engine tiver prefetch.

import { detectLanguage } from './lang-detect.js';

/** @typedef {{ id: string, pageNumber: number, index: number, text: string, start: number, end: number }} Sentence */
/** @typedef {{ pageNumber: number, text: string, sentences: Sentence[], isEmpty: boolean }} PageText */

const DEFAULT_SENTENCE_GAP_MS = 120;
const DEFAULT_PAGE_GAP_MS = 400;
// Voz neural: o próprio áudio já traz a respiração do fim da frase; pausa extra soa travada.
const NEURAL_SENTENCE_GAP_MS = 0;
const NEURAL_PAGE_GAP_MS = 150;
const MAX_CACHED_PAGES = 40;
const PREFETCH_AHEAD = 2;
const MAX_PREFETCH_KEYS = 400;
// Frase "longa" o bastante para ter idioma próprio, e confiança mínima para trocar.
const SENTENCE_LANG_MIN_LENGTH = 60;
const SENTENCE_LANG_MIN_CONFIDENCE = 0.6;
const MAX_PAGE_LANGS = 2000;

const sleep = (ms) => new Promise((resolve) => {
  if (ms > 0) setTimeout(resolve, ms);
  else resolve();
});

export class ReadingSession extends EventTarget {
  /**
   * @param {object} options
   * @param {import('./speech-engine.js').SpeechEngine} options.engine
   * @param {{ numPages: number, getPageText(n: number): Promise<PageText> }} options.source
   * @param {number} [options.sentenceGap] pausa entre frases (ms). Padrão: 120 (voz do
   *   navegador) ou 0 (voz neural, engine.kind === 'neural')
   * @param {number} [options.pageGap] pausa entre páginas (ms). Padrão: 400 ou 150 (neural)
   * @param {string} [options.language] 'auto' (padrão) ou um idioma fixo ('pt', 'en'...)
   * @param {string|null} [options.defaultLanguage] idioma quando a detecção não decide e não
   *   há página anterior. Padrão: o da voz escolhida, senão o do navegador, senão 'pt'
   */
  constructor({
    engine,
    source,
    sentenceGap,
    pageGap,
    language = 'auto',
    defaultLanguage = null,
  } = {}) {
    super();
    if (!engine || !source) throw new TypeError('ReadingSession precisa de { engine, source }.');
    this._engine = engine;
    this._source = source;
    const neural = engine.kind === 'neural';
    this._sentenceGap = sentenceGap ?? (neural ? NEURAL_SENTENCE_GAP_MS : DEFAULT_SENTENCE_GAP_MS);
    this._pageGap = pageGap ?? (neural ? NEURAL_PAGE_GAP_MS : DEFAULT_PAGE_GAP_MS);

    this._langMode = normalizeLangMode(language);
    this._defaultLang = defaultLanguage ? baseLang(defaultLanguage) : null;
    this._lang = null; // idioma da última frase anunciada
    this._lastDetected = null; // último idioma de página detectado com confiança
    this._pageLangs = new Map(); // pageNumber → { lang, confidence }
    this._prefetched = new Set(); // `${sentence.id}|${lang}` já pedidos nesta geração

    this._state = 'idle';
    this._pos = null; // { pageNumber, sentenceIndex } da frase atual (ou da próxima a ler)
    this._posPending = false; // true quando _pos já avançou além da frase que terminou
    this._sentence = null; // última frase anunciada
    this._lastPage = null;
    this._speechId = null;
    this._gen = 0;
    this._queue = Promise.resolve();
    this._pages = new Map();
    this._ready = new Set();
    this._failedPages = new Set();
    this._destroyed = false;

    this._onBoundary = (e) => this._handleBoundary(e);
    engine.addEventListener('boundary', this._onBoundary);
  }

  /** 'idle' | 'loading' | 'playing' | 'paused' | 'finished' */
  get state() {
    return this._state;
  }

  /** Posição atual para retomar ({ pageNumber, sentenceIndex }) ou null. */
  get position() {
    return this._pos ? { ...this._pos } : null;
  }

  /** Frase atual (a última anunciada em 'sentence') ou null. */
  get sentence() {
    return this._sentence;
  }

  /** Idioma da frase atual ('pt', 'en'...) ou null antes de começar. */
  get language() {
    return this._lang;
  }

  /** 'auto' ou o idioma fixado com setLanguage(). */
  get languageMode() {
    return this._langMode;
  }

  /**
   * Fixa o idioma da leitura ('pt', 'en', 'es'...) ou volta à detecção automática ('auto').
   * Vale a partir da próxima frase; para aplicar já na frase atual, chame restartCurrent().
   * @param {string} lang
   */
  setLanguage(lang) {
    const mode = normalizeLangMode(lang);
    if (mode === this._langMode) return;
    this._langMode = mode;
    this._prefetched.clear();
  }

  /**
   * Começa a ler a partir da página/frase indicada (pula páginas vazias). Chamar de novo
   * durante a leitura cancela a anterior.
   */
  start({ pageNumber = 1, sentenceIndex = 0 } = {}) {
    if (this._destroyed) return Promise.resolve();
    const gen = this._bump();
    this._setState('loading');
    const at = { pageNumber: Number(pageNumber) || 1, sentenceIndex: Math.max(0, Math.floor(Number(sentenceIndex) || 0)) };
    return this._enqueue(() => this._playFrom(gen, at));
  }

  pause() {
    if (this._state === 'playing') {
      this._engine.pause();
      this._setState('paused');
    } else if (this._state === 'loading') {
      this._setState('paused');
    }
  }

  resume() {
    if (this._state !== 'paused') return Promise.resolve();
    if (this._speechId && this._engine.state === 'paused') {
      this._engine.resume();
      this._setState('playing');
      return Promise.resolve();
    }
    return this._restart();
  }

  /** Play/pausa. Parado ou no fim, começa da posição salva (ou da página 1). */
  toggle() {
    switch (this._state) {
      case 'playing':
      case 'loading':
        this.pause();
        return Promise.resolve();
      case 'paused':
        return this.resume();
      default:
        return this.start(this._pos || undefined);
    }
  }

  /** Para a leitura e volta a 'idle', mantendo position para retomar. */
  stop() {
    if (this._state === 'idle') return;
    this._bump();
    this._setState('idle');
  }

  /** Próxima frase (atravessa páginas). Tocando: fala; pausado/parado: só move e emite 'sentence'. */
  next() {
    return this._navigate(1);
  }

  /** Frase anterior (atravessa páginas). */
  previous() {
    return this._navigate(-1);
  }

  /** Recomeça a frase atual com os ajustes novos (voz, velocidade, tom, volume). */
  restartCurrent() {
    if (this._state === 'playing' || this._state === 'loading') return this._restart();
    if (this._state === 'paused') this._bump(); // o resume() recomeça a frase do início
    return Promise.resolve();
  }

  /** Para tudo e solta os ouvintes do engine (use ao fechar o PDF). */
  destroy() {
    this.stop();
    this._destroyed = true;
    this._engine.removeEventListener('boundary', this._onBoundary);
    this._pages.clear();
    this._ready.clear();
  }

  // ---- internos ------------------------------------------------------------

  /** Nova geração: invalida laços/operações em andamento e cala o engine. */
  _bump() {
    this._gen += 1;
    this._speechId = null;
    this._prefetched.clear(); // o cancel() do engine abortou os pré-carregamentos pendentes
    this._engine.cancel();
    return this._gen;
  }

  _enqueue(fn) {
    const run = this._queue.then(fn).catch((err) => {
      console.warn('ReadingSession:', err);
      this._emitError('Erro inesperado na leitura. Tente de novo.');
    });
    this._queue = run;
    return run;
  }

  /** Recomeça da posição atual (lida quando a operação roda, não quando foi pedida). */
  _restart() {
    const gen = this._bump();
    if (this._state !== 'playing') this._setState('loading');
    return this._enqueue(() => this._playFrom(gen, null));
  }

  async _playFrom(gen, at) {
    let from = at;
    if (!from) {
      from = this._pos ? { ...this._pos } : { pageNumber: 1, sentenceIndex: 0 };
    }
    const target = await this._resolveForward(from.pageNumber, from.sentenceIndex);
    if (target) {
      this._pos = { pageNumber: target.pageNumber, sentenceIndex: target.sentenceIndex };
      this._posPending = false;
    }
    if (gen !== this._gen) return;

    if (!target) {
      const fromStart = from.pageNumber <= 1 && from.sentenceIndex <= 0;
      const any = fromStart ? null : await this._resolveForward(1, 0);
      if (gen !== this._gen) return;
      if (!any) {
        this._pos = null;
        this._setState('idle');
        this._emitError('Este PDF não tem texto para ler. Ele pode ser só imagem (digitalizado).', 'NO_TEXT');
        return;
      }
      this._finish();
      return;
    }

    if (this._state === 'paused') {
      this._announce(target.sentence, target.page);
      return;
    }
    this._runLoop(gen);
  }

  async _runLoop(gen) {
    const alive = () => gen === this._gen;
    while (alive()) {
      const from = this._pos;
      if (!this._ready.has(from.pageNumber) && this._state === 'playing') this._setState('loading');
      const target = await this._resolveForward(from.pageNumber, from.sentenceIndex, alive);
      if (!alive()) return;
      if (!target) {
        this._finish();
        return;
      }

      this._pos = { pageNumber: target.pageNumber, sentenceIndex: target.sentenceIndex };
      const lang = this._announce(target.sentence, target.page);
      if (this._state === 'paused') return; // pausou entre frases: espera o resume()

      this._setState('playing');
      this._preload(target.pageNumber + 1);
      const speechId = `${target.sentence.id}#${gen}`;
      this._speechId = speechId;

      let result;
      try {
        // o pedido da frase atual sai antes dos pré-carregamentos (o servidor atende em ordem)
        const speaking = this._engine.speak(target.sentence.text, { id: speechId, lang });
        this._markPrefetched(target.sentence, lang);
        this._prefetchAhead(gen, target);
        result = await speaking;
      } catch (err) {
        if (!alive()) return;
        this._speechId = null;
        this._setState('paused');
        this._emitError(err?.message || 'A leitura em voz alta falhou.', err?.code);
        return;
      }
      if (!alive()) return;
      this._speechId = null;
      if (result === 'cancelled') {
        // cancelado por fora (outra aba, o sistema): fica pausado nesta frase
        this._setState('paused');
        return;
      }

      const lastOnPage = target.sentenceIndex >= target.page.sentences.length - 1;
      this._pos = { pageNumber: target.pageNumber, sentenceIndex: target.sentenceIndex + 1 };
      this._posPending = true;
      await sleep(lastOnPage ? this._pageGap : this._sentenceGap);
    }
  }

  _navigate(step) {
    if (this._destroyed || !this._pos || this._state === 'finished') return Promise.resolve();
    const gen = this._bump();
    return this._enqueue(async () => {
      const cur = this._pos;
      if (!cur) return;
      const base = this._posPending ? cur.sentenceIndex - 1 : cur.sentenceIndex;
      const target = step > 0
        ? await this._resolveForward(cur.pageNumber, base + 1)
        : await this._resolveBackward(cur.pageNumber, base - 1);
      if (target) {
        this._pos = { pageNumber: target.pageNumber, sentenceIndex: target.sentenceIndex };
        this._posPending = false;
      }
      if (gen !== this._gen) return; // um comando mais novo continua daqui

      const playing = this._state === 'playing' || this._state === 'loading';
      if (!target && step > 0) {
        // já está na última frase do documento
        if (playing) this._finish();
        return;
      }
      if (playing) {
        this._runLoop(gen); // sem frase anterior: recomeça a atual
        return;
      }
      if (target) this._announce(target.sentence, target.page);
    });
  }

  _finish() {
    this._pos = null;
    this._posPending = false;
    this._speechId = null;
    this._setState('finished');
    this.dispatchEvent(new CustomEvent('finished', { detail: {} }));
  }

  /** Anuncia a frase (pagechange/langchange/sentence) e devolve o idioma dela. */
  _announce(sentence, page) {
    this._posPending = false;
    if (sentence.pageNumber !== this._lastPage) {
      this._lastPage = sentence.pageNumber;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: { pageNumber: sentence.pageNumber } }));
    }
    const info = this._sentenceLang(sentence, page);
    if (info.lang !== this._lang) {
      this._lang = info.lang;
      this.dispatchEvent(new CustomEvent('langchange', { detail: info }));
    }
    this._sentence = sentence;
    this.dispatchEvent(new CustomEvent('sentence', { detail: { sentence } }));
    return info.lang;
  }

  // ---- idioma --------------------------------------------------------------

  /** Idioma quando nada foi detectado: o da voz, o do navegador ou pt. */
  _fallbackLang() {
    if (this._defaultLang) return this._defaultLang;
    const voice = this._engine.voice;
    return baseLang(voice?.lang) || baseLang(globalThis.navigator?.language) || 'pt';
  }

  /** Idioma da página (detectado uma vez e guardado, para o pré-carregamento bater com a fala). */
  _pageLang(page) {
    const n = page?.pageNumber;
    const cached = this._pageLangs.get(n);
    if (cached) return cached;
    const fallback = this._pageLangs.get(n - 1)?.lang || this._lastDetected || this._fallbackLang();
    const found = page && hasText(page) ? detectLanguage(page.text, { fallback }) : null;
    const info = found ? { lang: found.lang, confidence: found.confidence } : { lang: fallback, confidence: 0 };
    if (info.confidence > 0) this._lastDetected = info.lang;
    if (this._pageLangs.size >= MAX_PAGE_LANGS) this._pageLangs.clear();
    this._pageLangs.set(n, info);
    return info;
  }

  /** { lang, confidence, source: 'fixed'|'page'|'sentence' } da frase. */
  _sentenceLang(sentence, page) {
    if (this._langMode !== 'auto') return { lang: this._langMode, confidence: 1, source: 'fixed' };
    const pageInfo = this._pageLang(page);
    const text = sentence.text || '';
    if (text.length >= SENTENCE_LANG_MIN_LENGTH) {
      const own = detectLanguage(text);
      if (own && own.lang !== pageInfo.lang && own.confidence >= SENTENCE_LANG_MIN_CONFIDENCE) {
        return { lang: own.lang, confidence: own.confidence, source: 'sentence' };
      }
    }
    return { lang: pageInfo.lang, confidence: pageInfo.confidence, source: 'page' };
  }

  // ---- pré-carregamento do áudio --------------------------------------------

  /** Marca a frase como já pedida ao engine. false se já estava marcada. */
  _markPrefetched(sentence, lang) {
    if (this._prefetched.size >= MAX_PREFETCH_KEYS) this._prefetched.clear();
    const key = `${sentence.id}|${lang}`;
    if (this._prefetched.has(key)) return false;
    this._prefetched.add(key);
    return true;
  }

  /** Pede ao engine as próximas frases (atravessando páginas), sem repetir pedidos. */
  async _prefetchAhead(gen, from) {
    if (typeof this._engine.prefetch !== 'function') return;
    const alive = () => gen === this._gen && !this._destroyed;
    let cur = from;
    try {
      for (let k = 0; k < PREFETCH_AHEAD && alive(); k += 1) {
        const next = await this._resolveForward(cur.pageNumber, cur.sentenceIndex + 1, alive, { quiet: true });
        if (!next || !alive()) return;
        const { lang } = this._sentenceLang(next.sentence, next.page);
        if (this._markPrefetched(next.sentence, lang)) {
          const p = this._engine.prefetch(next.sentence.text, { lang });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        cur = next;
      }
    } catch {
      // pré-carregar é só otimização: erros aparecem quando a frase for lida
    }
  }

  _handleBoundary(e) {
    const d = e.detail || {};
    const sentence = this._sentence;
    if (!this._speechId || d.id !== this._speechId || !sentence) return;
    const len = sentence.text.length;
    const charIndex = Math.max(0, Math.floor(Number(d.charIndex) || 0));
    if (charIndex >= len) return;
    const charLength = Math.max(1, Math.min(Math.floor(Number(d.charLength) || 1), len - charIndex));
    this.dispatchEvent(new CustomEvent('word', { detail: { sentence, charIndex, charLength } }));
  }

  _setState(state) {
    if (state === this._state) return;
    this._state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
  }

  _emitError(message, code) {
    this.dispatchEvent(new CustomEvent('error', { detail: { message, code } }));
  }

  // ---- páginas -------------------------------------------------------------

  _numPages() {
    return Math.max(0, Math.floor(Number(this._source.numPages) || 0));
  }

  _loadPage(n) {
    let p = this._pages.get(n);
    if (!p) {
      p = Promise.resolve()
        .then(() => this._source.getPageText(n))
        .then((page) => {
          this._ready.add(n);
          return normalizePage(page, n);
        }, (err) => {
          this._pages.delete(n);
          throw err;
        });
      this._pages.set(n, p);
      if (this._pages.size > MAX_CACHED_PAGES) {
        const oldest = this._pages.keys().next().value;
        this._pages.delete(oldest);
        this._ready.delete(oldest);
      }
    }
    return p;
  }

  _preload(n) {
    if (n >= 1 && n <= this._numPages() && !this._pages.has(n)) {
      this._loadPage(n).catch(() => {
        // o erro aparece quando a página for de fato necessária
      });
    }
  }

  _reportPageError(n, err) {
    if (this._failedPages.has(n)) return;
    this._failedPages.add(n);
    console.warn(`ReadingSession: falha ao ler a página ${n}`, err);
    this._emitError(`Não foi possível ler o texto da página ${n}. Ela foi pulada.`, 'PAGE_TEXT_FAILED');
  }

  /**
   * Primeira frase existente em (pageNumber, index) ou depois, pulando páginas vazias.
   * Retorna null no fim do documento, undefined se `alive()` ficou falso.
   * Com `quiet`, uma página com erro encerra a busca (undefined) sem avisar o usuário.
   */
  async _resolveForward(pageNumber, index, alive = () => true, { quiet = false } = {}) {
    const total = this._numPages();
    let i = Math.max(0, index);
    for (let p = Math.max(1, Math.floor(pageNumber)); p <= total; p += 1, i = 0) {
      let page;
      try {
        page = await this._loadPage(p);
      } catch (err) {
        if (!alive() || quiet) return undefined;
        this._reportPageError(p, err);
        continue;
      }
      if (!alive()) return undefined;
      if (hasText(page) && i < page.sentences.length) {
        return { pageNumber: p, sentenceIndex: i, sentence: page.sentences[i], page };
      }
    }
    return null;
  }

  /** Última frase existente em (pageNumber, index) ou antes. null se não há nenhuma. */
  async _resolveBackward(pageNumber, index) {
    let i = index;
    for (let p = Math.min(Math.floor(pageNumber), this._numPages()); p >= 1; p -= 1, i = Infinity) {
      let page;
      try {
        page = await this._loadPage(p);
      } catch (err) {
        this._reportPageError(p, err);
        continue;
      }
      if (!hasText(page)) continue;
      const idx = Math.min(i, page.sentences.length - 1);
      if (idx >= 0) return { pageNumber: p, sentenceIndex: idx, sentence: page.sentences[idx], page };
    }
    return null;
  }
}

function hasText(page) {
  return Boolean(page) && !page.isEmpty && page.sentences.length > 0;
}

function baseLang(lang) {
  return String(lang || '').trim().toLowerCase().replace(/_/g, '-').split('-')[0];
}

function normalizeLangMode(lang) {
  const base = baseLang(lang);
  return !base || base === 'auto' ? 'auto' : base;
}

function normalizePage(page, n) {
  if (page && Array.isArray(page.sentences)) return page;
  return { pageNumber: n, text: '', sentences: [], isEmpty: true };
}
