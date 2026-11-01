// Painel de ajustes de voz: gaveta lateral no computador, folha de baixo no celular.
// Mostra o motor de voz (IA neste computador ou navegador), o estado do servidor de voz,
// a voz, o idioma da leitura e os controles de velocidade, tom e volume.

import { el, formatDecimal } from '../utils/dom.js';
import { baseLanguage, languageName } from '../utils/languages.js';

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const MULTILINGUAL = '*multi*';

const VOICE_HINTS = {
  browser: 'No Edge, as vozes “Online (Natural)”, como Francisca e Antonio, soam mais naturais.',
  neural:
    'Vozes geradas por IA neste computador. Se a voz escolhida não fala o idioma do texto, é usada a voz recomendada daquele idioma.',
};

const GENDER = { f: 'feminina', m: 'masculina' };

/**
 * Voz como chega dos dois motores. O da IA pode trazer `languages` (vários idiomas),
 * `gender` e `engine`; o do navegador traz `lang` e `isDefault`.
 * @typedef {{ id: string, name: string, lang?: string, languages?: string[], gender?: string,
 *             engine?: string, localService?: boolean, isDefault?: boolean, default?: boolean }} Voice
 *
 * @typedef {'checking' | 'ready' | 'loading' | 'unavailable'} NeuralState
 *
 * @typedef {object} SettingsElements
 * @property {HTMLElement} panel
 * @property {HTMLElement} backdrop
 * @property {HTMLButtonElement} closeButton
 * @property {HTMLSelectElement} voiceSelect
 * @property {HTMLElement} voiceHint
 * @property {HTMLInputElement} rateInput
 * @property {HTMLOutputElement} rateValue
 * @property {HTMLElement} pitchField
 * @property {HTMLInputElement} pitchInput
 * @property {HTMLOutputElement} pitchValue
 * @property {HTMLInputElement} volumeInput
 * @property {HTMLOutputElement} volumeValue
 * @property {HTMLButtonElement} testButton
 * @property {HTMLButtonElement} resetButton
 * @property {HTMLElement} unavailableNote
 * @property {HTMLInputElement} engineNeural
 * @property {HTMLInputElement} engineBrowser
 * @property {HTMLElement} neuralStatus
 * @property {HTMLElement} neuralStatusText
 * @property {HTMLElement} neuralStatusDetail
 * @property {HTMLElement} neuralStatusHint
 * @property {HTMLButtonElement} neuralRetryButton
 * @property {HTMLElement} modelField
 * @property {HTMLSelectElement} modelSelect
 * @property {HTMLSelectElement} languageSelect
 * @property {HTMLElement} languageDetected
 */

/** Idiomas de uma voz (sem repetição). */
function voiceLanguages(voice) {
  const list = Array.isArray(voice.languages) && voice.languages.length ? voice.languages : [voice.lang];
  return [...new Set(list.filter(Boolean).map((l) => String(l)))];
}

/** Chave do grupo: código do idioma (como veio) ou o grupo "Multilíngue". */
function groupKey(voice) {
  const langs = voiceLanguages(voice);
  if (langs.length > 1) return MULTILINGUAL;
  return (langs[0] || '').replace('_', '-');
}

/** Ordem dos grupos: pt-BR, outros "pt", Multilíngue, depois os demais na ordem em que chegaram. */
function groupRank(key) {
  if (key === MULTILINGUAL) return 2;
  const l = key.toLowerCase();
  if (l === 'pt-br') return 0;
  if (baseLanguage(l) === 'pt') return 1;
  return 3;
}

function groupLabel(key) {
  return key === MULTILINGUAL ? 'Multilíngue' : languageName(key);
}

function voiceLabel(voice, kind) {
  const name = voice.name || voice.id;
  if (kind === 'neural') {
    const extras = [];
    const gender = GENDER[String(voice.gender || '').toLowerCase()];
    if (gender) extras.push(`voz ${gender}`);
    if (voice.isDefault || voice.default) extras.push('recomendada');
    return extras.length ? `${name} (${extras.join(', ')})` : name;
  }
  return voice.isDefault ? `${name} (padrão do sistema)` : name;
}

function formatRate(value) {
  return `${formatDecimal(value, 1)}×`;
}

function formatPitch(value) {
  if (Math.abs(value - 1) < 0.05) return 'Normal';
  return `${formatDecimal(value, 1)} (${value < 1 ? 'mais grave' : 'mais agudo'})`;
}

function formatVolume(value) {
  return `${Math.round(value * 100)}%`;
}

export class SettingsPanel {
  /**
   * @param {object} options
   * @param {SettingsElements} options.elements
   * @param {(voiceId: string) => void} options.onVoiceChange
   * @param {(rate: number) => void} options.onRateChange
   * @param {(pitch: number) => void} options.onPitchChange
   * @param {(volume: number) => void} options.onVolumeChange
   * @param {() => void} options.onTest
   * @param {() => void} options.onReset
   * @param {(kind: 'neural' | 'browser') => void} [options.onEngineChange]
   * @param {(modelId: string) => void} [options.onModelChange] motor neural (ex.: 'kokoro')
   * @param {(lang: string) => void} [options.onLanguageChange] 'auto' ou código do idioma
   * @param {() => void} [options.onRetryServer] "Verificar de novo"
   * @param {(open: boolean) => void} [options.onOpenChange]
   */
  constructor({
    elements,
    onVoiceChange,
    onRateChange,
    onPitchChange,
    onVolumeChange,
    onTest,
    onReset,
    onEngineChange = () => {},
    onModelChange = () => {},
    onLanguageChange = () => {},
    onRetryServer = () => {},
    onOpenChange = () => {},
  }) {
    this.els = elements;
    this.isOpen = false;
    this.returnFocusTo = null;
    this.onOpenChange = onOpenChange;
    this.enabled = true;
    this.testing = false;
    this.languageMode = 'auto';
    this.detectedLanguage = null;

    const bindSlider = (input, output, format, onCommit) => {
      // 'input' só atualiza o rótulo; 'change' (ao soltar) aplica, para não
      // reiniciar a frase a cada pixel arrastado.
      input.addEventListener('input', () => {
        output.textContent = format(Number(input.value));
      });
      input.addEventListener('change', () => onCommit(Number(input.value)));
    };
    bindSlider(elements.rateInput, elements.rateValue, formatRate, onRateChange);
    bindSlider(elements.pitchInput, elements.pitchValue, formatPitch, onPitchChange);
    bindSlider(elements.volumeInput, elements.volumeValue, formatVolume, onVolumeChange);

    elements.voiceSelect.addEventListener('change', () => {
      if (elements.voiceSelect.value) onVoiceChange(elements.voiceSelect.value);
    });
    for (const radio of [elements.engineNeural, elements.engineBrowser]) {
      radio.addEventListener('change', () => {
        if (radio.checked) onEngineChange(/** @type {'neural' | 'browser'} */ (radio.value));
      });
    }
    elements.modelSelect.addEventListener('change', () => {
      if (elements.modelSelect.value) onModelChange(elements.modelSelect.value);
    });
    elements.languageSelect.addEventListener('change', () => {
      this.languageMode = elements.languageSelect.value || 'auto';
      this.#renderDetected();
      onLanguageChange(this.languageMode);
    });
    elements.neuralRetryButton.addEventListener('click', () => onRetryServer());
    elements.testButton.addEventListener('click', () => onTest());
    elements.resetButton.addEventListener('click', () => onReset());
    elements.closeButton.addEventListener('click', () => this.close());
    elements.backdrop.addEventListener('click', () => this.close());

    elements.panel.addEventListener('keydown', (event) => this.#onKeydown(event));

    this.#applyClosedState();
  }

  // ---------- Motor de voz ----------

  /**
   * Marca o motor em uso e quais podem ser escolhidos.
   * @param {'neural' | 'browser' | null} kind null = nenhum motor disponível
   * @param {{ neuralAvailable: boolean, browserAvailable: boolean }} availability
   */
  setEngineChoice(kind, { neuralAvailable, browserAvailable }) {
    const { engineNeural, engineBrowser } = this.els;
    engineNeural.disabled = !neuralAvailable;
    engineBrowser.disabled = !browserAvailable;
    engineNeural.checked = kind === 'neural';
    engineBrowser.checked = kind === 'browser';
    engineNeural.closest('.choice')?.classList.toggle('is-disabled', !neuralAvailable);
    engineBrowser.closest('.choice')?.classList.toggle('is-disabled', !browserAvailable);
    this.els.voiceHint.textContent = VOICE_HINTS[kind ?? 'browser'];
  }

  /**
   * Estado da voz de IA (servidor local).
   * @param {object} status
   * @param {NeuralState} status.state
   * @param {string} [status.message] frase principal (ex.: "Pronta")
   * @param {string} [status.detail] linha extra (ex.: placa de vídeo, motivo do problema)
   * @param {boolean} [status.showHint] mostra a dica de como ligar o servidor
   */
  setNeuralStatus({ state, message, detail = '', showHint = false }) {
    const { neuralStatus, neuralStatusText, neuralStatusDetail, neuralStatusHint, neuralRetryButton } = this.els;
    neuralStatus.dataset.state = state;
    neuralStatusText.textContent = message || '';
    neuralStatusDetail.textContent = detail;
    neuralStatusDetail.hidden = !detail;
    neuralStatusHint.hidden = !showHint;
    neuralRetryButton.hidden = state !== 'unavailable';
    neuralRetryButton.disabled = false;
  }

  /** Mostra que a verificação está em andamento (desliga o botão para evitar cliques repetidos). */
  setRetrying() {
    this.els.neuralRetryButton.disabled = true;
    this.els.neuralStatusText.textContent = 'Verificando a voz de IA…';
    this.els.neuralStatus.dataset.state = 'checking';
  }

  /**
   * Lista de motores neurais (só aparece se houver mais de um disponível).
   * @param {{ id: string, name: string }[]} models
   * @param {string | null} selectedId
   * @param {{ visible: boolean }} options visible = o motor atual é a voz de IA
   */
  setNeuralModels(models, selectedId, { visible }) {
    const { modelField, modelSelect } = this.els;
    modelSelect.replaceChildren(...models.map((m) => el('option', { value: m.id }, m.name || m.id)));
    if (selectedId && models.some((m) => m.id === selectedId)) modelSelect.value = selectedId;
    modelField.hidden = !visible || models.length < 2;
    modelSelect.disabled = !this.enabled;
  }

  // ---------- Vozes ----------

  /**
   * Preenche a lista de vozes, agrupada por idioma (pt-BR primeiro; vozes de vários
   * idiomas no grupo "Multilíngue").
   * @param {Voice[]} voices já na ordem do motor
   * @param {string | null} selectedId
   * @param {'neural' | 'browser'} [kind]
   */
  setVoices(voices, selectedId, kind = 'browser') {
    const select = this.els.voiceSelect;
    select.replaceChildren();

    if (!voices.length) {
      select.append(el('option', { value: '' }, kind === 'neural' ? 'Nenhuma voz de IA disponível' : 'Nenhuma voz encontrada'));
      select.disabled = true;
      return;
    }

    /** @type {Map<string, Voice[]>} */
    const groups = new Map();
    for (const voice of voices) {
      const key = groupKey(voice);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(voice);
    }

    const ordered = [...groups.entries()]
      .map(([key, list], order) => ({ key, list, order }))
      .sort((a, b) => groupRank(a.key) - groupRank(b.key) || a.order - b.order);

    for (const { key, list } of ordered) {
      const group = el('optgroup', { label: groupLabel(key) });
      for (const voice of list) group.append(el('option', { value: voice.id }, voiceLabel(voice, kind)));
      select.append(group);
    }

    select.disabled = !this.enabled;
    if (selectedId && voices.some((v) => v.id === selectedId)) select.value = selectedId;
  }

  /** @param {boolean} visible false quando o motor não muda o tom (voz de IA) */
  setPitchVisible(visible) {
    this.els.pitchField.hidden = !visible;
  }

  // ---------- Idioma ----------

  /**
   * Idiomas que podem ser fixados em "Idioma da leitura".
   * @param {string[]} languages códigos curtos ('pt', 'en'...)
   * @param {string} selected 'auto' ou um código
   */
  setLanguages(languages, selected) {
    const select = this.els.languageSelect;
    const list = [...new Set(languages.map(baseLanguage).filter(Boolean))];
    // O idioma escolhido continua na lista mesmo se o motor atual não o oferece.
    if (selected && selected !== 'auto' && !list.includes(selected)) list.push(selected);
    list.sort((a, b) => (a === 'pt' ? -1 : b === 'pt' ? 1 : languageName(a).localeCompare(languageName(b), 'pt-BR')));
    select.replaceChildren(
      el('option', { value: 'auto' }, 'Automático (descobre pelo texto)'),
      ...list.map((code) => el('option', { value: code }, languageName(code))),
    );
    this.languageMode = selected || 'auto';
    select.value = this.languageMode;
    select.disabled = !this.enabled;
    this.#renderDetected();
  }

  /**
   * Idioma detectado durante a leitura (só aparece no modo automático).
   * @param {string | null} lang
   */
  setDetectedLanguage(lang) {
    this.detectedLanguage = lang ? baseLanguage(lang) : null;
    this.#renderDetected();
  }

  #renderDetected() {
    const node = this.els.languageDetected;
    const show = this.languageMode === 'auto' && Boolean(this.detectedLanguage);
    node.hidden = !show;
    node.textContent = show ? `Detectado: ${languageName(this.detectedLanguage)}` : '';
  }

  // ---------- Valores e estado geral ----------

  /**
   * Mostra os valores atuais nos controles.
   * @param {{ rate?: number, pitch?: number, volume?: number }} values
   */
  setValues({ rate, pitch, volume }) {
    if (rate !== undefined) {
      this.els.rateInput.value = String(rate);
      this.els.rateValue.textContent = formatRate(rate);
    }
    if (pitch !== undefined) {
      this.els.pitchInput.value = String(pitch);
      this.els.pitchValue.textContent = formatPitch(pitch);
    }
    if (volume !== undefined) {
      this.els.volumeInput.value = String(volume);
      this.els.volumeValue.textContent = formatVolume(volume);
    }
  }

  /**
   * Liga/desliga os controles de voz (o motor e o "Verificar de novo" continuam ativos).
   * @param {boolean} enabled
   * @param {string} [message] aviso mostrado quando desligado
   */
  setEnabled(enabled, message) {
    this.enabled = enabled;
    const { voiceSelect, rateInput, pitchInput, volumeInput, testButton, resetButton, unavailableNote, languageSelect, modelSelect } =
      this.els;
    for (const control of [voiceSelect, rateInput, pitchInput, volumeInput, resetButton, languageSelect, modelSelect]) {
      control.disabled = !enabled;
    }
    testButton.disabled = !enabled || this.testing;
    if (message) unavailableNote.textContent = message;
    unavailableNote.hidden = enabled;
  }

  /**
   * "Testar voz" ocupado enquanto a frase de teste é gerada e falada.
   * @param {boolean} testing
   */
  setTesting(testing) {
    this.testing = testing;
    const button = this.els.testButton;
    button.disabled = !this.enabled || testing;
    button.setAttribute('aria-busy', String(testing));
    const label = button.querySelector('.btn-label');
    if (label) label.textContent = testing ? 'Testando…' : 'Testar voz';
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { panel, backdrop } = this.els;
    panel.inert = false;
    panel.removeAttribute('aria-hidden');
    panel.classList.add('is-open');
    backdrop.hidden = false;
    this.onOpenChange(true);
    const first = panel.querySelector(FOCUSABLE);
    // Espera a gaveta começar a aparecer antes de focar (evita salto de rolagem).
    requestAnimationFrame(() => (first instanceof HTMLElement ? first : panel).focus({ preventScroll: true }));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.#applyClosedState();
    this.onOpenChange(false);
    if (this.returnFocusTo?.isConnected) this.returnFocusTo.focus({ preventScroll: true });
    this.returnFocusTo = null;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  #applyClosedState() {
    const { panel, backdrop } = this.els;
    panel.classList.remove('is-open');
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
  }

  #onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    // Mantém o foco dentro do painel enquanto ele está aberto.
    const items = [...this.els.panel.querySelectorAll(FOCUSABLE)].filter(
      (node) => node instanceof HTMLElement && node.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
