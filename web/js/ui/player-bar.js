// Barra do player: play/pausa, parar, frase anterior/próxima, legenda e progresso.
// Também mostra, sem travar nada, o aviso "Carregando voz de IA…" e o selo do idioma lido.

import { languageBadge, languageName } from '../utils/languages.js';

const IDLE_HINT = 'Toque em ▶ para ouvir. Toque num trecho do PDF para ler a partir dele.';
const NO_DOC_HINT = 'Abra um PDF para começar.';

const PLAY_LABELS = {
  idle: 'Ler em voz alta',
  finished: 'Ler de novo',
  loading: 'Preparando a leitura',
  playing: 'Pausar',
  paused: 'Continuar',
};

/**
 * @typedef {object} PlayerElements
 * @property {HTMLElement} root
 * @property {HTMLButtonElement} playButton
 * @property {HTMLButtonElement} stopButton
 * @property {HTMLButtonElement} prevButton
 * @property {HTMLButtonElement} nextButton
 * @property {HTMLElement} caption
 * @property {HTMLElement} progressBar elemento com role="progressbar"
 * @property {HTMLElement} progressFill
 * @property {HTMLElement} progressLabel
 * @property {HTMLElement} [status] linha "Carregando voz de IA…" (escondida por padrão)
 * @property {HTMLElement} [statusText]
 * @property {HTMLElement} [langBadge] selo do idioma (ex.: "PT")
 */

export class PlayerBar {
  /**
   * @param {object} options
   * @param {PlayerElements} options.elements
   * @param {() => void} options.onToggle play/pausa
   * @param {() => void} options.onStop
   * @param {() => void} options.onPrevious
   * @param {() => void} options.onNext
   */
  constructor({ elements, onToggle, onStop, onPrevious, onNext }) {
    this.els = elements;
    this.available = true;
    this.unavailableMessage = '';
    this.hasDocument = false;
    this.state = 'idle';

    elements.playButton.addEventListener('click', () => onToggle());
    elements.stopButton.addEventListener('click', () => onStop());
    elements.prevButton.addEventListener('click', () => onPrevious());
    elements.nextButton.addEventListener('click', () => onNext());

    this.reset();
  }

  /**
   * Liga/desliga o player inteiro (ex.: navegador sem voz sintética).
   * @param {boolean} available
   * @param {string} [message] explicação mostrada no lugar da legenda
   */
  setAvailable(available, message = '') {
    this.available = available;
    this.unavailableMessage = message;
    this.els.root.classList.toggle('is-unavailable', !available);
    this.#renderButtons();
    if (!available) this.setCaption(message);
    else if (!this.hasDocument) this.setCaption(NO_DOC_HINT);
  }

  /** @param {boolean} loaded */
  setDocumentLoaded(loaded) {
    this.hasDocument = loaded;
    this.#renderButtons();
    if (!this.available) return;
    this.setCaption(loaded ? IDLE_HINT : NO_DOC_HINT, { muted: true });
  }

  /**
   * Estado da leitura vindo da ReadingSession.
   * @param {'idle' | 'loading' | 'playing' | 'paused' | 'finished'} state
   */
  setState(state) {
    this.state = state;
    const play = this.els.playButton;
    play.dataset.state = state;
    const label = PLAY_LABELS[state] ?? PLAY_LABELS.idle;
    play.setAttribute('aria-label', label);
    play.title = label;
    play.setAttribute('aria-busy', String(state === 'loading'));
    this.els.root.dataset.state = state;
    this.#renderButtons();
  }

  /**
   * Texto da legenda (a frase sendo lida).
   * @param {string} text
   * @param {{ muted?: boolean }} [options] muted = texto de ajuda, não uma frase do PDF
   */
  setCaption(text, { muted = false } = {}) {
    this.els.caption.textContent = text;
    this.els.caption.classList.toggle('is-muted', muted);
  }

  /** Volta a mostrar a dica de uso na legenda. */
  showIdleHint() {
    if (!this.available) return;
    this.setCaption(this.hasDocument ? IDLE_HINT : NO_DOC_HINT, { muted: true });
  }

  /**
   * Progresso de leitura dentro da página atual.
   * @param {{ pageNumber: number, numPages: number, fraction: number }} progress
   *   fraction = parte da página já lida (0 a 1)
   */
  setProgress({ pageNumber, numPages, fraction }) {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    const text = `Página ${pageNumber} de ${numPages}`;
    this.els.progressFill.style.width = `${percent}%`;
    this.els.progressBar.setAttribute('aria-valuenow', String(percent));
    this.els.progressBar.setAttribute('aria-valuetext', `${text}, ${percent}% da página lida`);
    this.els.progressLabel.textContent = text;
  }

  /**
   * Aviso discreto de que a voz ainda está sendo preparada (ex.: o modelo de IA carregando).
   * @param {boolean} loading
   * @param {string} [text]
   */
  setVoiceLoading(loading, text = 'Carregando voz de IA… na primeira vez pode levar até 30 segundos.') {
    const { status, statusText } = this.els;
    if (!status) return;
    if (loading && statusText) statusText.textContent = text;
    status.hidden = !loading;
  }

  /**
   * Selo do idioma da leitura.
   * @param {string | null} lang null esconde o selo
   * @param {{ fixed?: boolean }} [options] fixed = escolhido pelo usuário (não detectado)
   */
  setLanguage(lang, { fixed = false } = {}) {
    const badge = this.els.langBadge;
    if (!badge) return;
    const code = lang ? languageBadge(lang) : '';
    badge.hidden = !code;
    badge.textContent = code;
    if (code) {
      const label = `Idioma da leitura: ${languageName(lang)}${fixed ? ' (escolhido nos ajustes)' : ' (detectado)'}`;
      badge.setAttribute('aria-label', label);
      badge.title = label;
    }
  }

  /** Estado inicial (sem documento). */
  reset() {
    this.setVoiceLoading(false);
    this.setLanguage(null);
    this.els.progressFill.style.width = '0%';
    this.els.progressBar.setAttribute('aria-valuenow', '0');
    this.els.progressBar.removeAttribute('aria-valuetext');
    this.els.progressLabel.textContent = '';
    this.setState('idle');
    if (this.available) this.showIdleHint();
  }

  #renderButtons() {
    const usable = this.available && this.hasDocument;
    const active = this.state === 'playing' || this.state === 'paused' || this.state === 'loading';
    this.els.playButton.disabled = !usable;
    this.els.stopButton.disabled = !usable || !active;
    this.els.prevButton.disabled = !usable || !active;
    this.els.nextButton.disabled = !usable || !active;
  }
}
