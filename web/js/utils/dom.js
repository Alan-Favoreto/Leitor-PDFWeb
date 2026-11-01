// Pequenos utilitários de DOM usados pela interface.

/**
 * Atalho para querySelector.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element | null}
 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Atalho para querySelectorAll, já como array.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element[]}
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Busca um elemento pelo id e falha cedo se ele não existir no HTML.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado na página.`);
  return node;
}

/**
 * Cria um elemento com atributos e filhos.
 * Atributos especiais: `class`, `dataset` (objeto), `on<Evento>` (função),
 * valores `true` viram atributo vazio e `false`/`null`/`undefined` são ignorados.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') {
      node.className = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/**
 * Atrasa a chamada até `wait` ms sem novas chamadas.
 * A função devolvida tem `.cancel()` e `.flush()` (executa já, se houver pendência).
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F & { cancel(): void, flush(): void }}
 */
export function debounce(fn, wait) {
  let timer = null;
  let pendingArgs = null;
  const run = () => {
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };
  const debounced = (...args) => {
    pendingArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  return /** @type {any} */ (debounced);
}

/**
 * Limita um número ao intervalo [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Formata um número no padrão brasileiro (vírgula decimal).
 * @param {number} value
 * @param {number} [digits=1] casas decimais
 */
export function formatDecimal(value, digits = 1) {
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * true se o alvo é um campo onde o usuário digita ou ajusta valores
 * (input, textarea, select ou conteúdo editável). Usado pelos atalhos de teclado.
 * @param {EventTarget | null} target
 */
export function isTextEntry(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable=""], [contenteditable="true"]')) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * true se o alvo é um controle que já reage a Espaço/Enter por conta própria.
 * @param {EventTarget | null} target
 */
export function isActivatable(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a[href], summary, [role="button"]'));
}
