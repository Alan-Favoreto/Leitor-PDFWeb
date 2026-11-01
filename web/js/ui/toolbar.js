// Cabeçalho: abrir arquivo, título, página atual/total, zoom, tema e ajustes.

const APP_TITLE = 'Leitor de PDF com Voz';

/**
 * @typedef {object} ToolbarElements
 * @property {HTMLButtonElement} openButton
 * @property {HTMLElement} title
 * @property {HTMLInputElement} pageInput
 * @property {HTMLElement} pageTotal
 * @property {HTMLButtonElement} zoomOut
 * @property {HTMLButtonElement} zoomIn
 * @property {HTMLButtonElement} zoomFit
 * @property {HTMLElement} zoomLabel
 * @property {HTMLButtonElement} themeButton
 * @property {HTMLButtonElement} settingsButton
 */

export class Toolbar {
  /**
   * @param {object} options
   * @param {ToolbarElements} options.elements
   * @param {(pageNumber: number) => void} options.onGoToPage
   * @param {() => void} options.onZoomIn
   * @param {() => void} options.onZoomOut
   * @param {() => void} options.onZoomFit
   * @param {() => void} options.onToggleTheme
   * @param {() => void} options.onOpenSettings
   * O botão de abrir arquivo é ligado pelo file-drop.js.
   */
  constructor({ elements, onGoToPage, onZoomIn, onZoomOut, onZoomFit, onToggleTheme, onOpenSettings }) {
    this.els = elements;
    this.numPages = 0;
    this.currentPage = 0;
    this.onGoToPage = onGoToPage;

    const { pageInput } = elements;
    this.valueAtFocus = '';
    pageInput.addEventListener('focus', () => {
      this.valueAtFocus = pageInput.value;
      pageInput.select();
    });
    // Enter (ou "Ir" no teclado do celular) ou sair do campo = ir para a página digitada.
    // Esc desiste e volta a mostrar a página atual.
    pageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        pageInput.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.#renderPage();
        pageInput.blur();
      }
    });
    pageInput.addEventListener('blur', () => this.#submitPage());

    elements.zoomOut.addEventListener('click', () => onZoomOut());
    elements.zoomIn.addEventListener('click', () => onZoomIn());
    elements.zoomFit.addEventListener('click', () => onZoomFit());
    elements.themeButton.addEventListener('click', () => onToggleTheme());
    elements.settingsButton.addEventListener('click', () => onOpenSettings());

    this.setDocument(null);
  }

  /**
   * Mostra o documento aberto, ou volta ao estado inicial com `null`.
   * @param {{ title: string, numPages: number } | null} doc
   */
  setDocument(doc) {
    const loaded = Boolean(doc);
    this.numPages = loaded ? doc.numPages : 0;
    this.currentPage = loaded ? 1 : 0;
    this.setTitle(loaded ? doc.title : APP_TITLE);
    this.els.pageTotal.textContent = loaded ? String(doc.numPages) : '–';
    this.els.pageInput.disabled = !loaded;
    this.els.pageInput.setAttribute('aria-label', loaded ? `Página atual, de ${doc.numPages}` : 'Página atual');
    for (const button of [this.els.zoomOut, this.els.zoomIn, this.els.zoomFit]) {
      button.disabled = !loaded;
    }
    if (!loaded) this.els.zoomLabel.textContent = '–';
    this.#renderPage();
  }

  /** @param {string} text */
  setTitle(text) {
    this.els.title.textContent = text;
    this.els.title.title = text;
  }

  /** Mostra que um arquivo está sendo aberto. */
  setLoading(fileName) {
    this.setTitle(fileName ? `Abrindo ${fileName}…` : 'Abrindo…');
  }

  /** @param {number} pageNumber */
  setPage(pageNumber) {
    if (!this.numPages) return;
    this.currentPage = pageNumber;
    // Não atrapalha quem está digitando o número da página.
    if (document.activeElement !== this.els.pageInput) this.#renderPage();
  }

  /** @param {number} zoom 1 = 100% */
  setZoom(zoom) {
    if (!Number.isFinite(zoom)) return;
    this.els.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  /**
   * Ajusta o ícone e o rótulo do botão de tema.
   * @param {'light' | 'dark'} effectiveTheme tema que está valendo agora
   */
  setTheme(effectiveTheme) {
    const button = this.els.themeButton;
    button.dataset.theme = effectiveTheme;
    const label = effectiveTheme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  /** @param {boolean} open */
  setSettingsExpanded(open) {
    this.els.settingsButton.setAttribute('aria-expanded', String(open));
  }

  #renderPage() {
    this.els.pageInput.value = this.numPages ? String(this.currentPage) : '';
  }

  #submitPage() {
    if (!this.numPages) return;
    // Só entrou e saiu do campo, sem mudar nada: não mexe na rolagem.
    if (this.els.pageInput.value === this.valueAtFocus) {
      this.#renderPage();
      return;
    }
    const value = Number.parseInt(this.els.pageInput.value.replace(/\D+/g, ''), 10);
    if (!Number.isFinite(value)) {
      this.#renderPage();
      return;
    }
    const page = Math.min(this.numPages, Math.max(1, value));
    this.currentPage = page;
    this.#renderPage();
    this.onGoToPage(page);
  }
}
