// PdfViewer: rolagem contínua de todas as páginas, renderização sob demanda, zoom e destaque
// da frase/palavra lida na camada de texto do pdf.js.
import { TextLayer, RenderingCancelledException, AbortException } from './pdfjs.js';
import { getItemRanges, itemSourceRange, sourceToTextOffset, findSentenceAt } from './text-extractor.js';

const CSS_UNITS = 96 / 72;            // zoom 1 = 100% = tamanho real (pt → px CSS)
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const AUTO_MAX_ZOOM = 1.25;           // 'auto' = ajustar à largura, sem passar de 125%
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const KEEP_DISTANCE = 4;              // páginas além da área visível que mantêm o canvas
const MAX_CONCURRENT_RENDERS = 2;
const RESIZE_DEBOUNCE_MS = 150;
const CLICK_MAX_DISTANCE = 24;        // px: toque fora do texto conta para o trecho mais próximo
const MAX_CANVAS_PIXELS = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  ? 2 ** 24
  : 2 ** 25;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function isCancel(err) {
  return err instanceof RenderingCancelledException || err instanceof AbortException ||
    err?.name === 'RenderingCancelledException' || err?.name === 'AbortException';
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  // Zerar o tamanho ajuda o Safari/iOS a devolver a memória na hora.
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

function scrollBehavior(requested = 'smooth') {
  if (requested !== 'smooth') return requested;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

/**
 * Visualizador de PDF com rolagem contínua.
 * Eventos: 'pagechange' { pageNumber }, 'zoomchange' { zoom, mode }, 'sentenceclick' { sentence }.
 */
export class PdfViewer extends EventTarget {
  #container;
  #root = null;
  #doc = null;
  #views = [];
  #openGen = 0;
  #abort = null;
  #io = null;
  #ro = null;
  #near = new Set();
  #queue = new Set();
  #activeRenders = 0;
  #updateScheduled = false;
  #resizeTimer = 0;
  #zoom = 1;
  #zoomMode = 'auto';           // 'auto' | 'fit-width' | 'custom'
  #scale = CSS_UNITS;
  #dpr = 1;
  #currentPage = 1;
  #hl = { sentence: null, word: null }; // word = [inicio, fim) em PageText.text
  #pendingScrollId = null;
  #pointerDown = null;

  /** @param {HTMLElement} containerEl elemento com overflow:auto e altura definida */
  constructor(containerEl) {
    super();
    if (!containerEl) throw new TypeError('PdfViewer precisa de um elemento container.');
    this.#container = containerEl;
  }

  // -------------------------------------------------------------------------
  // Abrir / fechar

  /**
   * Monta os espaços de todas as páginas (com o tamanho certo) e renderiza sob demanda.
   * @param {PdfDoc} pdfDoc
   */
  async open(pdfDoc) {
    this.close();
    const gen = ++this.#openGen;
    this.#doc = pdfDoc;
    const firstPage = await pdfDoc.raw.getPage(1);
    if (gen !== this.#openGen) return;
    const base = firstPage.getViewport({ scale: 1 });

    const root = document.createElement('div');
    root.className = 'pdf-viewer';
    this.#views = [];
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const div = document.createElement('div');
      div.className = 'pdf-page is-loading';
      div.dataset.pageNumber = String(n);
      div.setAttribute('role', 'region');
      div.setAttribute('aria-label', `Página ${n}`);
      root.append(div);
      this.#views.push(this.#createView(n, div, base.width, base.height));
    }
    this.#views[0].page = firstPage;
    this.#root = root;
    this.#container.append(root);

    this.#dpr = window.devicePixelRatio || 1;
    this.#currentPage = 1;
    this.#zoomMode = 'auto';
    this.#zoom = this.#fitZoom('auto');
    this.#scale = this.#zoom * CSS_UNITS;
    for (const view of this.#views) this.#applyPageSize(view);
    this.#container.scrollTop = 0;

    this.#listen();
    this.#emit('zoomchange', { zoom: this.#zoom, mode: this.#zoomMode });
    this.#emit('pagechange', { pageNumber: 1 });
    this.#update();
    this.#scanPageSizes(gen);
  }

  /** Fecha o documento atual (não destrói o PdfDoc; isso é com quem abriu). */
  close() {
    this.#openGen++;
    this.#abort?.abort();
    this.#abort = null;
    this.#io?.disconnect();
    this.#io = null;
    this.#ro?.disconnect();
    this.#ro = null;
    clearTimeout(this.#resizeTimer);
    this.#queue.clear();
    this.#near.clear();
    for (const view of this.#views) this.#releaseView(view);
    this.#views = [];
    this.#root?.remove();
    this.#root = null;
    this.#doc = null;
    this.#hl = { sentence: null, word: null };
    this.#pendingScrollId = null;
    this.#currentPage = 1;
  }

  // -------------------------------------------------------------------------
  // Navegação e zoom

  /** Página mais visível (1-based). */
  get currentPage() {
    return this.#currentPage;
  }

  /** Número de páginas do documento aberto (0 se nenhum). */
  get pageCount() {
    return this.#views.length;
  }

  /**
   * Rola até o topo da página n.
   * @param {number} n
   * @param {{ behavior?: 'smooth'|'auto' }} [options]
   */
  goToPage(n, { behavior = 'smooth' } = {}) {
    const view = this.#views[clamp(Math.round(n) || 1, 1, this.#views.length) - 1];
    if (!view) return;
    const far = Math.abs(view.n - this.#currentPage) > 3;
    const top = this.#rootOffsetTop() + view.div.offsetTop - this.#pageGap();
    this.#queueRender(view);
    this.#container.scrollTo({ top: Math.max(0, top), behavior: far ? 'auto' : scrollBehavior(behavior) });
  }

  /** Zoom efetivo (1 = 100%). */
  get zoom() {
    return this.#zoom;
  }

  /** 'auto' | 'fit-width' | 'custom' */
  get zoomMode() {
    return this.#zoomMode;
  }

  /**
   * @param {number|'fit-width'|'auto'} value número (1 = 100%), 'fit-width' (largura da tela)
   *   ou 'auto' (largura da tela, no máximo 125%; é o padrão ao abrir)
   */
  setZoom(value) {
    if (value === 'fit-width' || value === 'auto') {
      this.#zoomMode = value;
      this.#applyZoom(this.#fitZoom(value), true);
      return;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return;
    this.#zoomMode = 'custom';
    this.#applyZoom(clamp(num, MIN_ZOOM, MAX_ZOOM), true);
  }

  zoomIn() {
    const next = ZOOM_STEPS.find((z) => z > this.#zoom + 0.001) ?? MAX_ZOOM;
    this.setZoom(next);
  }

  zoomOut() {
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < this.#zoom - 0.001) ?? MIN_ZOOM;
    this.setZoom(prev);
  }

  // -------------------------------------------------------------------------
  // Destaques

  /**
   * Destaca a frase na camada de texto. Rola só se ela estiver fora da área visível.
   * Se a página ainda não foi desenhada, o destaque aparece quando ela ficar pronta.
   * @param {Sentence|null} sentence
   * @param {{ scroll?: boolean }} [options]
   */
  highlightSentence(sentence, { scroll = true } = {}) {
    const old = this.#hl.sentence;
    this.#hl = { sentence: sentence || null, word: null };
    if (old) this.#repaintRange(old.pageNumber, old.start, old.end);
    this.#pendingScrollId = null;
    if (!sentence) return;
    const view = this.#views[sentence.pageNumber - 1];
    if (!view) return;
    if (view.textState === 'done') {
      this.#repaintRange(sentence.pageNumber, sentence.start, sentence.end);
      if (scroll) this.#scrollToHighlight();
      return;
    }
    if (scroll) {
      this.#pendingScrollId = sentence.id;
      if (!this.#isPageNearView(view)) this.goToPage(view.n, { behavior: 'auto' });
      this.#queueRender(view);
    }
  }

  /**
   * Destaca a palavra atual dentro da frase.
   * @param {Sentence} sentence
   * @param {number} charIndex relativo a sentence.text
   * @param {number} [charLength] se faltar (alguns navegadores), vai até o fim da palavra
   */
  highlightWord(sentence, charIndex, charLength) {
    if (!sentence) {
      this.#setWord(null);
      return;
    }
    if (!this.#hl.sentence || this.#hl.sentence.id !== sentence.id ||
        this.#hl.sentence.pageNumber !== sentence.pageNumber) {
      this.highlightSentence(sentence, { scroll: false });
    }
    const len = sentence.text.length;
    const from = clamp(Math.floor(charIndex) || 0, 0, len);
    let size = Math.floor(charLength) || 0;
    if (size <= 0) {
      const m = /^[\p{L}\p{N}\p{M}'’-]+/u.exec(sentence.text.slice(from));
      size = m ? m[0].length : 0;
    }
    const to = clamp(from + size, from, len);
    if (to <= from) {
      this.#setWord(null);
      return;
    }
    this.#setWord([sentence.start + from, sentence.start + to]);
    this.#scrollToHighlight({ selector: '.hl-word' });
  }

  // -------------------------------------------------------------------------
  // Internos: páginas

  #createView(n, div, w1, h1) {
    return {
      n,
      div,
      w1,                 // largura/altura em pontos com zoom 1 (já com a rotação da página)
      h1,
      page: null,
      gen: 0,
      state: 'idle',      // 'idle' | 'rendering' | 'done' | 'error'
      renderTask: null,
      renderingScale: 0,
      renderedScale: 0,
      renderedDpr: 0,
      canvas: null,
      textState: 'none',  // 'none' | 'loading' | 'done' | 'error'
      textGen: 0,
      textLayer: null,
      textDiv: null,
      textScale: 0,
      spans: [],
      spanIndex: null,
      pageText: null,
      ranges: null,
      painted: new Set(),
    };
  }

  #applyPageSize(view) {
    const { style } = view.div;
    style.width = `${Math.floor(view.w1 * this.#scale)}px`;
    style.height = `${Math.floor(view.h1 * this.#scale)}px`;
    style.setProperty('--scale-factor', String(this.#scale));
  }

  /** Busca em segundo plano o tamanho real de cada página (podem variar dentro do PDF). */
  async #scanPageSizes(gen) {
    const doc = this.#doc;
    for (let n = 2; n <= this.#views.length; n++) {
      let page;
      try {
        page = await doc.raw.getPage(n);
      } catch {
        continue;
      }
      if (gen !== this.#openGen) return;
      const view = this.#views[n - 1];
      view.page ??= page;
      const vp = page.getViewport({ scale: 1 });
      if (Math.abs(vp.width - view.w1) < 0.5 && Math.abs(vp.height - view.h1) < 0.5) continue;
      const oldHeight = view.div.offsetHeight;
      const above = view.div.offsetTop + oldHeight <= this.#viewTop();
      view.w1 = vp.width;
      view.h1 = vp.height;
      this.#applyPageSize(view);
      if (view.state === 'done') view.renderedScale = 0; // proporção mudou: redesenhar
      // Mantém o leitor no mesmo lugar se a página que mudou está acima dele.
      if (above) this.#container.scrollTop += view.div.offsetHeight - oldHeight;
    }
  }

  #queueRender(view) {
    if (!view) return;
    this.#queue.add(view);
    this.#pump();
  }

  #needsRender(view) {
    if (view.state === 'rendering') return false;
    if (view.state === 'error') return false;
    return view.state !== 'done' || view.renderedScale !== this.#scale ||
      view.renderedDpr !== this.#dpr || view.textState === 'none';
  }

  #pump() {
    while (this.#activeRenders < MAX_CONCURRENT_RENDERS && this.#queue.size) {
      // Primeiro a página da frase lida, depois as mais perto da página atual.
      const pinned = this.#hl.sentence?.pageNumber;
      let best = null;
      for (const v of this.#queue) {
        const d = v.n === pinned ? -1 : Math.abs(v.n - this.#currentPage);
        if (!best || d < best.d) best = { v, d };
      }
      this.#queue.delete(best.v);
      if (!this.#needsRender(best.v)) continue;
      this.#activeRenders++;
      this.#renderView(best.v).finally(() => {
        this.#activeRenders--;
        this.#pump();
      });
    }
  }

  async #renderView(view) {
    const doc = this.#doc;
    if (!doc) return;
    const scale = this.#scale;
    const dpr = this.#dpr;
    const gen = ++view.gen;
    if (view.renderTask) view.renderTask.cancel();
    view.state = 'rendering';
    view.renderingScale = scale;
    try {
      const page = view.page || (view.page = await doc.raw.getPage(view.n));
      if (gen !== view.gen) return;
      const viewport = page.getViewport({ scale });

      if (view.renderedScale !== scale || view.renderedDpr !== dpr || !view.canvas) {
        let outScale = dpr;
        const cssPixels = viewport.width * viewport.height;
        if (cssPixels * outScale * outScale > MAX_CANVAS_PIXELS) {
          outScale = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels);
        }
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.width = Math.max(1, Math.floor(viewport.width * outScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outScale));
        const sx = canvas.width / viewport.width;
        const sy = canvas.height / viewport.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        view.renderTask = page.render({
          canvasContext: ctx,
          viewport,
          transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null,
        });
        try {
          await view.renderTask.promise;
        } finally {
          view.renderTask = null;
        }
        if (gen !== view.gen) {
          releaseCanvas(canvas);
          return;
        }
        // Troca só depois de pronto: o canvas antigo (esticado) evita piscar no zoom.
        if (view.canvas) {
          view.canvas.replaceWith(canvas);
          releaseCanvas(view.canvas);
        } else {
          view.div.prepend(canvas);
        }
        view.canvas = canvas;
        view.renderedScale = scale;
        view.renderedDpr = dpr;
      }
      view.state = 'done';
      view.div.classList.remove('is-loading', 'has-error');
      await this.#ensureTextLayer(view);
    } catch (err) {
      if (isCancel(err) || gen !== view.gen) {
        if (gen === view.gen) view.state = view.canvas ? 'done' : 'idle';
        return;
      }
      view.state = 'error';
      view.div.classList.remove('is-loading');
      view.div.classList.add('has-error');
      console.warn(`Não foi possível desenhar a página ${view.n}.`, err);
    }
  }

  async #ensureTextLayer(view) {
    if (view.textState === 'done') {
      if (view.textScale !== this.#scale) {
        view.textLayer.update({ viewport: view.page.getViewport({ scale: this.#scale }) });
        view.textScale = this.#scale;
      }
      return;
    }
    if (view.textState !== 'none') return; // carregando, ou falhou (não insiste)
    view.textState = 'loading';
    const tgen = view.textGen;
    let textLayer = null;
    try {
      const { textContent, pageText } = await this.#doc.getTextData(view.n);
      if (tgen !== view.textGen) return; // página liberada no meio do caminho
      const div = document.createElement('div');
      div.className = 'textLayer';
      const viewport = view.page.getViewport({ scale: this.#scale });
      textLayer = new TextLayer({ textContentSource: textContent, container: div, viewport });
      view.textLayer = textLayer;
      await textLayer.render();
      if (tgen !== view.textGen) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      div.append(end);
      view.div.append(div);
      view.textDiv = div;
      view.textScale = viewport.scale;
      view.spans = textLayer.textDivs;
      view.spanIndex = new WeakMap(view.spans.map((s, i) => [s, i]));
      view.pageText = pageText;
      view.ranges = getItemRanges(pageText) || [];
      view.painted.clear();
      view.textState = 'done';
      if (view.textScale !== this.#scale) {
        textLayer.update({ viewport: view.page.getViewport({ scale: this.#scale }) });
        view.textScale = this.#scale;
      }
      this.#onTextLayerReady(view);
    } catch (err) {
      if (tgen !== view.textGen || isCancel(err)) return;
      view.textState = 'error';
      if (view.textLayer === textLayer) view.textLayer = null;
      console.warn(`Não foi possível montar o texto da página ${view.n}.`, err);
    }
  }

  #onTextLayerReady(view) {
    const s = this.#hl.sentence;
    if (!s || s.pageNumber !== view.n) return;
    this.#repaintRange(view.n, s.start, s.end);
    if (this.#pendingScrollId === s.id) {
      this.#pendingScrollId = null;
      this.#scrollToHighlight();
    }
  }

  /** Libera canvas e camada de texto (a página volta a ser só um espaço reservado). */
  #releaseView(view) {
    view.gen++;
    view.textGen++;
    view.renderTask?.cancel();
    view.renderTask = null;
    if (view.textState === 'loading') view.textLayer?.cancel();
    view.textLayer = null;
    view.textDiv?.remove();
    view.textDiv = null;
    view.textState = 'none';
    view.spans = [];
    view.spanIndex = null;
    view.painted.clear();
    releaseCanvas(view.canvas);
    view.canvas = null;
    view.state = 'idle';
    view.renderedScale = 0;
    view.renderedDpr = 0;
    view.div.classList.add('is-loading');
    view.div.classList.remove('has-error');
    view.page?.cleanup();
  }

  // -------------------------------------------------------------------------
  // Internos: rolagem, visibilidade, zoom

  #listen() {
    this.#abort = new AbortController();
    const { signal } = this.#abort;
    const container = this.#container;
    container.addEventListener('scroll', () => this.#scheduleUpdate(), { passive: true, signal });

    this.#io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = Number(e.target.dataset.pageNumber);
        if (e.isIntersecting) this.#near.add(n);
        else this.#near.delete(n);
      }
      this.#scheduleUpdate();
    }, { root: container, rootMargin: '50% 0px', threshold: 0 });
    for (const view of this.#views) this.#io.observe(view.div);

    this.#ro = new ResizeObserver(() => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.#onResize(), RESIZE_DEBOUNCE_MS);
    });
    this.#ro.observe(container);
    window.addEventListener('resize', () => {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.#onResize(), RESIZE_DEBOUNCE_MS);
    }, { signal });

    const root = this.#root;
    root.addEventListener('pointerdown', (e) => this.#onPointerDown(e), { signal });
    root.addEventListener('pointerup', () => this.#endSelecting(), { signal });
    root.addEventListener('pointercancel', () => this.#endSelecting(), { signal });
    root.addEventListener('click', (e) => this.#onClick(e), { signal });
  }

  #onResize() {
    if (!this.#root) return;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.#dpr) this.#dpr = dpr; // #needsRender vai redesenhar com a nova densidade
    if (this.#zoomMode !== 'custom') {
      this.#applyZoom(this.#fitZoom(this.#zoomMode), false);
    }
    this.#scheduleUpdate();
  }

  #scheduleUpdate() {
    if (this.#updateScheduled) return;
    this.#updateScheduled = true;
    requestAnimationFrame(() => {
      this.#updateScheduled = false;
      this.#update();
    });
  }

  #rootOffsetTop() {
    // Distância do topo do conteúdo rolável até o topo do .pdf-viewer.
    const c = this.#container.getBoundingClientRect();
    const r = this.#root.getBoundingClientRect();
    return r.top - c.top - this.#container.clientTop + this.#container.scrollTop;
  }

  /** Topo da área visível, nas coordenadas do .pdf-viewer. */
  #viewTop() {
    return this.#container.scrollTop - this.#rootOffsetTop();
  }

  #pageGap() {
    if (!this.#root) return 0;
    const v = parseFloat(getComputedStyle(this.#root).getPropertyValue('--pdf-page-gap'));
    return Number.isFinite(v) ? v : 12;
  }

  /** Faixa de páginas visíveis e a mais visível. */
  #visibleRange() {
    const views = this.#views;
    if (!views.length || !this.#root) return null;
    const top = this.#viewTop();
    const height = this.#container.clientHeight;
    if (height <= 0) return null;
    const bottom = top + height;
    // Busca binária: primeira página cujo fim passa do topo visível.
    let lo = 0;
    let hi = views.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const d = views[mid].div;
      if (d.offsetTop + d.offsetHeight <= top) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    let bestVisible = -1;
    let last = lo;
    for (let i = lo; i < views.length; i++) {
      const d = views[i].div;
      if (d.offsetTop >= bottom) break;
      last = i;
      const visible = Math.min(bottom, d.offsetTop + d.offsetHeight) - Math.max(top, d.offsetTop);
      if (visible > bestVisible + 1) {
        best = i;
        bestVisible = visible;
      }
    }
    return { first: lo + 1, last: last + 1, current: best + 1 };
  }

  #isPageNearView(view) {
    const range = this.#visibleRange();
    return !!range && view.n >= range.first - 1 && view.n <= range.last + 1;
  }

  #update() {
    if (!this.#root) return;
    const range = this.#visibleRange();
    if (!range) return;
    if (range.current !== this.#currentPage) {
      this.#currentPage = range.current;
      this.#emit('pagechange', { pageNumber: range.current });
    }
    const wanted = new Set();
    for (let n = range.first - 1; n <= range.last + 1; n++) {
      if (n >= 1 && n <= this.#views.length) wanted.add(n);
    }
    for (const n of this.#near) wanted.add(n);

    this.#queue.clear();
    for (const n of wanted) this.#queue.add(this.#views[n - 1]);
    const pinned = this.#hl.sentence?.pageNumber;
    if (this.#pendingScrollId && pinned) this.#queue.add(this.#views[pinned - 1]);

    for (const view of this.#views) {
      if (view.state === 'idle' && view.textState === 'none' && !view.canvas) continue;
      if (wanted.has(view.n) || view.n === pinned) continue;
      if (view.n < range.first - KEEP_DISTANCE || view.n > range.last + KEEP_DISTANCE) {
        this.#releaseView(view);
      }
    }
    this.#pump();
  }

  #fitZoom(mode) {
    const view = this.#views[this.#currentPage - 1] || this.#views[0];
    if (!view || !this.#root) return 1;
    const style = getComputedStyle(this.#root);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const available = this.#container.clientWidth - padX - 2;
    if (available <= 50) return this.#zoom || 1;
    let z = available / (view.w1 * CSS_UNITS);
    if (mode === 'auto') z = Math.min(z, AUTO_MAX_ZOOM);
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  #applyZoom(zoom, emitAlways) {
    if (!this.#root) {
      this.#zoom = zoom;
      return;
    }
    const changed = Math.abs(zoom - this.#zoom) > 1e-4;
    if (changed) {
      // Guarda o ponto de leitura (página atual + fração) para voltar a ele após o zoom.
      const view = this.#views[this.#currentPage - 1];
      const top = this.#viewTop();
      const fraction = view ? (top - view.div.offsetTop) / Math.max(1, view.div.offsetHeight) : 0;
      const container = this.#container;
      const xFraction = container.scrollWidth > container.clientWidth
        ? (container.scrollLeft + container.clientWidth / 2) / container.scrollWidth
        : 0.5;

      this.#zoom = zoom;
      this.#scale = zoom * CSS_UNITS;
      for (const v of this.#views) this.#applyPageSize(v);

      if (view) {
        const target = view.div.offsetTop + fraction * view.div.offsetHeight;
        container.scrollTop += target - this.#viewTop();
      }
      if (container.scrollWidth > container.clientWidth) {
        container.scrollLeft = xFraction * container.scrollWidth - container.clientWidth / 2;
      }
      // Camadas de texto já prontas acompanham o novo --scale-factor; os canvas são
      // redesenhados conforme ficam visíveis.
      for (const v of this.#views) {
        if (v.textState === 'done' && v.page) {
          v.textLayer.update({ viewport: v.page.getViewport({ scale: this.#scale }) });
          v.textScale = this.#scale;
        }
      }
    }
    if (changed || emitAlways) this.#emit('zoomchange', { zoom: this.#zoom, mode: this.#zoomMode });
    if (changed) this.#update();
  }

  // -------------------------------------------------------------------------
  // Internos: pintura dos destaques

  #setWord(word) {
    const old = this.#hl.word;
    this.#hl.word = word;
    const s = this.#hl.sentence;
    if (!s) return;
    if (old) this.#repaintRange(s.pageNumber, old[0], old[1]);
    if (word) this.#repaintRange(s.pageNumber, word[0], word[1]);
  }

  #repaintRange(pageNumber, from, to) {
    const view = this.#views[pageNumber - 1];
    if (!view || view.textState !== 'done') return;
    const ranges = view.ranges;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r && r.start < to && r.end > from) this.#paintSpan(view, i);
    }
    // Spans pintados que já não cruzam nada (ex.: frase em outra página).
    for (const i of [...view.painted]) {
      const r = ranges[i];
      if (!r || r.start >= to || r.end <= from) this.#paintSpan(view, i);
    }
  }

  #paintSpan(view, i) {
    const span = view.spans[i];
    const range = view.ranges[i];
    if (!span) return;
    const str = view.textLayer?.textContentItemsStr?.[i] ?? span.textContent;

    if (view.painted.has(i)) {
      span.classList.remove('hl-sentence');
      if (span.firstElementChild) span.textContent = str;
      view.painted.delete(i);
    }
    const { sentence, word } = this.#hl;
    if (!range || !sentence || sentence.pageNumber !== view.n) return;
    const sRange = itemSourceRange(range, sentence.start, sentence.end);
    if (!sRange) return;
    const wRange = word ? itemSourceRange(range, word[0], word[1]) : null;

    const whole = !str.slice(0, sRange[0]).trim() && !str.slice(sRange[1]).trim();
    if (whole) span.classList.add('hl-sentence');
    view.painted.add(i);
    if (whole && !wRange) return;

    // Trecho parcial: envolve só a parte da frase/palavra num <mark>.
    const cuts = new Set([0, str.length]);
    if (!whole) {
      cuts.add(sRange[0]);
      cuts.add(sRange[1]);
    }
    if (wRange) {
      cuts.add(wRange[0]);
      cuts.add(wRange[1]);
    }
    const points = [...cuts].filter((c) => c >= 0 && c <= str.length).sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k];
      const b = points[k + 1];
      if (b <= a) continue;
      const piece = str.slice(a, b);
      let cls = null;
      if (wRange && a >= wRange[0] && b <= wRange[1]) cls = 'hl-word';
      else if (!whole && a >= sRange[0] && b <= sRange[1]) cls = 'hl-sentence';
      if (cls) {
        const mark = document.createElement('mark');
        mark.className = cls;
        mark.textContent = piece;
        frag.append(mark);
      } else {
        frag.append(document.createTextNode(piece));
      }
    }
    span.replaceChildren(frag);
  }

  /** Rola para mostrar o destaque, só se ele estiver (parcialmente) fora da área visível. */
  #scrollToHighlight({ selector = '.hl-sentence' } = {}) {
    const s = this.#hl.sentence;
    if (!s) return;
    const view = this.#views[s.pageNumber - 1];
    if (!view?.textDiv) return;
    const els = view.textDiv.querySelectorAll(selector);
    if (!els.length) return;
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    if (!Number.isFinite(top)) return;
    const container = this.#container;
    const c = container.getBoundingClientRect();
    const viewTop = c.top + container.clientTop;
    const viewBottom = viewTop + container.clientHeight;
    const viewLeft = c.left + container.clientLeft;
    const viewRight = viewLeft + container.clientWidth;
    const margin = Math.min(24, container.clientHeight * 0.05);

    let dy = 0;
    if (top < viewTop + margin || bottom > viewBottom - margin) {
      const height = bottom - top;
      const anchor = height < container.clientHeight * 0.6 ? 0.25 : 0.08;
      dy = top - (viewTop + container.clientHeight * anchor);
    }
    let dx = 0;
    if (container.scrollWidth > container.clientWidth && (left < viewLeft || right > viewRight)) {
      dx = left - viewLeft - margin;
    }
    if (dy || dx) {
      container.scrollBy({ top: dy, left: dx, behavior: scrollBehavior('smooth') });
    }
  }

  // -------------------------------------------------------------------------
  // Internos: toque/clique na camada de texto

  #onPointerDown(e) {
    const sel = window.getSelection?.();
    this.#pointerDown = {
      x: e.clientX,
      y: e.clientY,
      hadSelection: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0,
    };
    const layer = e.target.closest?.('.textLayer');
    if (layer) layer.classList.add('selecting');
  }

  #endSelecting() {
    for (const el of this.#root?.querySelectorAll('.textLayer.selecting') || []) {
      el.classList.remove('selecting');
    }
  }

  #onClick(e) {
    if (e.button !== 0) return;
    const down = this.#pointerDown;
    this.#pointerDown = null;
    if (down?.hadSelection) return; // o toque só desfez uma seleção
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) return; // arrastou
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // usuário selecionando texto

    const pageDiv = e.target.closest?.('.pdf-page');
    if (!pageDiv) return;
    const view = this.#views[Number(pageDiv.dataset.pageNumber) - 1];
    if (!view || view.textState !== 'done' || !view.pageText) return;

    const offset = this.#textOffsetAtPoint(view, e);
    if (offset == null) return;
    const sentence = findSentenceAt(view.pageText, offset);
    if (sentence) this.#emit('sentenceclick', { sentence });
  }

  #textOffsetAtPoint(view, e) {
    let span = e.target.closest?.('span');
    let index = span ? view.spanIndex.get(span) : undefined;
    let srcOffset = null;

    if (index !== undefined && view.ranges[index]) {
      srcOffset = this.#caretSourceOffset(span, e.clientX, e.clientY);
    } else {
      // Toque entre palavras ou na margem: usa o trecho com texto mais próximo.
      index = undefined;
      let best = CLICK_MAX_DISTANCE;
      for (let i = 0; i < view.spans.length; i++) {
        if (!view.ranges[i] || !view.spans[i].isConnected) continue;
        const r = view.spans[i].getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        const d = Math.hypot(dx, dy * 2); // linha errada pesa mais que distância na mesma linha
        if (d < best) {
          best = d;
          index = i;
        }
      }
      if (index === undefined) return null;
      span = view.spans[index];
      const r = span.getBoundingClientRect();
      srcOffset = e.clientX > r.right ? Infinity : 0;
    }
    const range = view.ranges[index];
    if (srcOffset === Infinity) return range.end - 1;
    return sourceToTextOffset(range, srcOffset ?? 0);
  }

  /** Posição do caractere tocado dentro do texto original do span. */
  #caretSourceOffset(span, x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (!node || !span.contains(node) || node.nodeType !== Node.TEXT_NODE) return 0;
    // O span pode estar dividido em <mark>: soma os textos anteriores.
    let total = 0;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t === node) return total + offset;
      total += t.length;
    }
    return 0;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
