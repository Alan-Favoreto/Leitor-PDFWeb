// Divide textos longos em pedaços seguros para a voz e faz uma limpeza leve para a fala.
// Tudo aqui é puro (sem DOM). A limpeza preserva o comprimento do texto, então os
// offsets do texto limpo valem também para o texto original.

export const DEFAULT_MAX_LENGTH = 200;
const MIN_MAX_LENGTH = 40;

const SPACE_RE = /\s/;
const STRONG_RE = /[.!?…]/;
const MEDIUM_RE = /[,;:—–]/;
const CLOSER_RE = /["'”’»)\]}]/;
// Pontuação que encerra uma palavra (para medir a palavra quando o navegador não dá charLength).
const WORD_END_RE = /[\s.,;:!?…"“”«»()[\]{}]/;
// Pontuação boa para um corte forçado dentro de um "palavrão" sem espaços.
const SOFT_BREAK_RE = /[,;:/.\-–—_|]/;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const URL_TRAIL_RE = /[.,;:!?)\]}'"»”’]+$/;
// 3 ou mais símbolos iguais seguidos ("-----", "......", "____", "****").
const REPEATED_RE = /([^\p{L}\p{N}\s])\1{2,}/gu;
// Marcadores de lista e símbolos que algumas vozes leem em voz alta.
const BULLET_RE = /[•▪■□►▶◦●○◆◇★☆✓✔❖➢➤|]/g;

const HAS_SPEECH_RE = /[\p{L}\p{N}]/u;

/** true se o texto tem algo pronunciável (letra ou número). */
export function hasSpeech(text) {
  return HAS_SPEECH_RE.test(String(text ?? ''));
}

/**
 * Limpeza leve para fala, preservando o comprimento (troca por espaços):
 * URLs viram "link", sequências de símbolos repetidos e marcadores de lista somem.
 * @param {string} text
 * @returns {string} texto com o mesmo .length do original
 */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(URL_RE, (m) => {
      const trail = (m.match(URL_TRAIL_RE) || [''])[0];
      const core = m.length - trail.length;
      if (core < 4) return m;
      return 'link' + ' '.repeat(core - 4) + trail;
    })
    .replace(REPEATED_RE, (m) => {
      // reticências e "!!!"/"???" curtos dão entonação; o resto vira espaço
      if (m.length <= 3 && /^[.!?]+$/.test(m)) return m;
      return ' '.repeat(m.length);
    })
    .replace(BULLET_RE, (m) => ' '.repeat(m.length));
}

/**
 * Divide o texto em pedaços de até maxLength caracteres. Corta de preferência depois de
 * pontuação forte (. ! ? …), depois de , ; : —, depois em espaço; nunca no meio de uma
 * palavra (a única exceção é uma "palavra" sem espaços maior que maxLength).
 * Cada pedaço é um trecho exato do texto: text.slice(start, end) === chunk.text.
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function chunkText(text, { maxLength = DEFAULT_MAX_LENGTH } = {}) {
  const src = String(text ?? '');
  const max = Math.max(MIN_MAX_LENGTH, Math.floor(Number(maxLength)) || DEFAULT_MAX_LENGTH);
  const minPreferred = Math.floor(max * 0.35);
  const chunks = [];
  let pos = skipSpaces(src, 0);

  while (pos < src.length) {
    const tail = trimEnd(src, pos, src.length);
    if (tail - pos <= max) {
      if (tail > pos) chunks.push({ text: src.slice(pos, tail), start: pos, end: tail });
      break;
    }
    const cut = findCut(src, pos, max, minPreferred);
    const end = trimEnd(src, pos, cut);
    if (end > pos) chunks.push({ text: src.slice(pos, end), start: pos, end });
    pos = skipSpaces(src, cut);
  }
  return chunks;
}

/**
 * Posição e tamanho da palavra que começa em `index` (ou logo depois, pulando espaços).
 * Usa `reportedLength` se for válido e o trecho não tiver sido alterado pela limpeza;
 * senão mede até o fim da palavra no texto original.
 * @param {string} original texto original
 * @param {string} spoken texto limpo (mesmo comprimento) que foi de fato falado
 * @param {number} index
 * @param {number} [reportedLength]
 * @returns {{ charIndex: number, charLength: number } | null}
 */
export function wordSpanAt(original, spoken, index, reportedLength) {
  const len = original.length;
  let i = Math.max(0, Math.floor(index));
  while (i < len && SPACE_RE.test(spoken[i] ?? original[i])) i += 1;
  if (i >= len) return null;

  let size = Number.isFinite(reportedLength) && reportedLength > 0 ? Math.floor(reportedLength) : 0;
  if (size) size = Math.max(0, size - (i - Math.floor(index)));

  if (!size) size = measure(original, i, WORD_END_RE);
  if (spoken.slice(i, i + size) !== original.slice(i, i + size)) {
    // trecho trocado pela limpeza (ex.: URL lida como "link"): destaca a URL inteira
    size = measure(original, i, SPACE_RE);
  }
  return { charIndex: i, charLength: Math.min(size, len - i) };
}

// ---------------------------------------------------------------------------

function measure(text, from, endRe) {
  let j = from;
  while (j < text.length && !endRe.test(text[j])) j += 1;
  return Math.max(1, j - from);
}

function skipSpaces(src, i) {
  while (i < src.length && SPACE_RE.test(src[i])) i += 1;
  return i;
}

function trimEnd(src, from, to) {
  while (to > from && SPACE_RE.test(src[to - 1])) to -= 1;
  return to;
}

/** Classe do corte que termina em c (c é um espaço): 3 = forte, 2 = médio, 1 = espaço. */
function cutClass(src, pos, c) {
  let k = c - 1;
  while (k > pos && CLOSER_RE.test(src[k])) k -= 1;
  if (STRONG_RE.test(src[k])) return 3;
  if (MEDIUM_RE.test(src[k])) return 2;
  return 1;
}

/** Índice (exclusivo) onde termina o pedaço que começa em pos. */
function findCut(src, pos, max, minPreferred) {
  const limit = Math.min(pos + max, src.length);
  let strong = -1;
  let medium = -1;
  let space = -1;

  // c é um ponto de corte quando src[c] é espaço e src[c - 1] não é
  for (let c = limit; c > pos; c -= 1) {
    if (!SPACE_RE.test(src[c] ?? ' ') || SPACE_RE.test(src[c - 1])) continue;
    const kind = cutClass(src, pos, c);
    if (space < 0) space = c;
    if (kind === 3 && strong < 0) strong = c;
    if (kind >= 2 && medium < 0) medium = c;
    if (strong >= 0 && strong - pos >= minPreferred) break;
  }

  if (strong >= 0 && strong - pos >= minPreferred) return strong;
  if (medium >= 0 && medium - pos >= minPreferred) return medium;
  if (space >= 0) return space;

  // Nenhum espaço na janela: uma "palavra" maior que o limite (ex.: sequência sem espaços).
  for (let c = limit; c - pos >= minPreferred; c -= 1) {
    if (SOFT_BREAK_RE.test(src[c - 1])) return c;
  }
  let hard = limit;
  const code = src.charCodeAt(hard - 1);
  if (code >= 0xd800 && code <= 0xdbff && hard - 1 > pos) hard -= 1; // não parte emoji/surrogate
  return hard;
}
