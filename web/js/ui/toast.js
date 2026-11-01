// Avisos curtos (toasts) que aparecem acima da barra do player.

import { el } from '../utils/dom.js';

const DEFAULT_DURATION = { info: 5000, success: 4000, warning: 9000, error: 9000 };
const MAX_VISIBLE = 3;

const CLOSE_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * @typedef {{ label: string, onClick: () => void }} ToastAction
 * @typedef {{ type?: 'info' | 'success' | 'warning' | 'error', duration?: number, action?: ToastAction }} ToastOptions
 * @typedef {{ dismiss(): void }} ToastHandle
 */

export class Toaster {
  /**
   * @param {HTMLElement} regionEl contêiner com aria-live onde os avisos entram
   */
  constructor(regionEl) {
    this.region = regionEl;
    /** @type {Map<HTMLElement, { message: string, timer: any, handle: ToastHandle, duration: number }>} */
    this.items = new Map();
  }

  /**
   * Mostra um aviso. Se o mesmo texto já estiver na tela, só renova o tempo dele.
   * @param {string} message
   * @param {ToastOptions} [options] duration 0 = fica até fechar
   * @returns {ToastHandle}
   */
  show(message, { type = 'info', duration, action } = {}) {
    for (const [node, item] of this.items) {
      if (item.message === message) {
        this.#schedule(node, item.duration);
        return item.handle;
      }
    }

    const time = duration ?? (action ? 10000 : DEFAULT_DURATION[type] ?? 5000);
    const node = el('div', { class: 'toast', dataset: { type } });
    node.append(el('p', { class: 'toast-message' }, message));

    if (action) {
      node.append(
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-text toast-action',
            onClick: () => {
              handle.dismiss();
              action.onClick();
            },
          },
          action.label,
        ),
      );
    }

    const close = el('button', {
      type: 'button',
      class: 'btn btn-icon toast-close',
      'aria-label': 'Fechar aviso',
      onClick: () => handle.dismiss(),
    });
    close.innerHTML = CLOSE_ICON;
    node.append(close);

    const handle = { dismiss: () => this.#remove(node) };
    this.items.set(node, { message, timer: null, handle, duration: time });
    this.region.append(node);
    this.#schedule(node, time);

    // Limita a quantidade de avisos ao mesmo tempo (sai o mais antigo).
    while (this.items.size > MAX_VISIBLE) {
      const oldest = this.items.keys().next().value;
      this.#remove(oldest);
    }
    return handle;
  }

  /** Remove todos os avisos. */
  clear() {
    for (const node of [...this.items.keys()]) this.#remove(node);
  }

  #schedule(node, duration) {
    const item = this.items.get(node);
    if (!item) return;
    clearTimeout(item.timer);
    item.timer = duration > 0 ? setTimeout(() => this.#remove(node), duration) : null;
  }

  #remove(node) {
    const item = this.items.get(node);
    if (!item) return;
    clearTimeout(item.timer);
    this.items.delete(node);
    node.remove();
  }
}
