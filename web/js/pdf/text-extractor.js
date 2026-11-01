// Converte o textContent de uma página do pdf.js em PageText (texto corrido + frases).
//
// Este módulo é puro (não importa o pdf.js) para poder ser testado fora do navegador.
// Além do PageText, guarda um mapa interno "item do textContent → faixa de offsets em
// PageText.text", que o viewer usa para destacar a frase na camada de texto.
//
// O índice de item usado aqui conta só os itens que têm `str` (os mesmos para os quais o
// TextLayer do pdf.js cria um <span>), então itemRanges[i] corresponde a textLayer.textDivs[i].

// Abreviações comuns (minúsculas, sem o ponto final). Depois delas o ponto não encerra a frase.
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'srs', 'sras', 'srta', 'srtas', 'dr', 'dra', 'drs', 'dras', 'prof', 'profa',
  'profs', 'profas', 'eng', 'enga', 'arq', 'adv', 'exmo', 'exma', 'ilmo', 'ilma', 'revmo',
  'sto', 'sta', 'av', 'pça', 'al', 'ap', 'apto', 'bl', 'cj', 'núm', 'num', 'nº', 'n°', 'pág',
  'pag', 'págs', 'pags', 'pp', 'cap', 'caps', 'fig', 'figs', 'tab', 'vol', 'vols', 'ed',
  'eds', 'org', 'orgs', 'coord', 'trad', 'art', 'arts', 'inc', 'parág', 'cf', 'ex', 'obs',
  'op', 'cit', 'ibid', 'id', 'et', 'aprox', 'ref', 'refs', 'séc', 'tel', 'ltda', 'cia',
  'jan', 'fev', 'abr', 'jun', 'jul', 'ago', 'vs', 'mr', 'mrs', 'ms', 'jr', 'st',
]);

// Enclíticos que costumam vir depois de hífen no fim da linha ("disse-\nlhe" → "disse-lhe").
const KEEP_HYPHEN_BEFORE = new Set(['lhe', 'lhes']);

const HYPHENS = '-‐‑';
const BULLET_START = /^(?:[•◦▪▫●○■□►▸‣⁃–—➢➤✓✔*]|\d{1,2}[.)]\s|[a-zA-Z][)]\s)/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const ONLY_NUMBER = /^[\p{P}\p{S}\s]*\d+[\p{P}\p{S}\s]*$/u;
const LEADING_JUNK = /^[^\p{L}\p{N}"'“‘«(\[¿¡$€£#@]+/u;

/** Faixas de cada PageText (WeakMap para não aparecer no objeto público). */
const itemRangesByPage = new WeakMap();

let sentenceSegmenter = null;
try {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    sentenceSegmenter = new Intl.Segmenter('pt', { granularity: 'sentence' });
  }
} catch {
  sentenceSegmenter = null;
}

/**
 * Monta o PageText de uma página a partir do resultado de `page.getTextContent()`.
 * @param {{ items: Array<object> }} textContent
 * @param {number} pageNumber 1-based
 * @returns {PageText}
 */
export function extractPageText(textContent, pageNumber) {
  const lines = buildLines(textContent?.items || []);
  const { text, ranges } = joinLines(lines);
  const sentences = splitSentences(text, pageNumber);
  const pageText = {
    pageNumber,
    text,
    sentences,
    isEmpty: sentences.length === 0,
  };
  itemRangesByPage.set(pageText, ranges);
  return pageText;
}

/**
 * Mapa interno item → faixa. Cada posição é `null` (item sem texto aproveitado) ou
 * `{ start, end, srcStart, src }`: [start, end) em PageText.text; `src` é um Int32Array com o
 * índice em `item.str` de cada caractere emitido, ou `null` quando os caracteres são
 * contíguos a partir de `srcStart`.
 * @param {PageText} pageText
 * @returns {Array<object|null>|null}
 */
export function getItemRanges(pageText) {
  return itemRangesByPage.get(pageText) || null;
}

/**
 * Parte do item que fica dentro de [from, to) do texto da página, em índices de `item.str`.
 * @returns {[number, number]|null} [srcFrom, srcTo) ou null se não há interseção
 */
export function itemSourceRange(range, from, to) {
  if (!range) return null;
  const a = Math.max(from, range.start);
  const b = Math.min(to, range.end);
  if (a >= b) return null;
  return [toSource(range, a - range.start), toSource(range, b - 1 - range.start) + 1];
}

/**
 * Converte uma posição dentro de `item.str` para offset em PageText.text.
 * @returns {number|null}
 */
export function sourceToTextOffset(range, srcIndex) {
  if (!range) return null;
  const len = range.end - range.start;
  if (!range.src) {
    const k = Math.min(Math.max(srcIndex - range.srcStart, 0), len - 1);
    return range.start + k;
  }
  for (let k = 0; k < len; k++) {
    if (range.src[k] >= srcIndex) return range.start + k;
  }
  return range.end - 1;
}

/**
 * Frase que contém o offset (ou a próxima, se o offset cai entre frases).
 * @param {PageText} pageText
 * @param {number} offset
 * @returns {Sentence|null}
 */
export function findSentenceAt(pageText, offset) {
  const list = pageText?.sentences || [];
  if (!list.length) return null;
  for (const s of list) {
    if (offset < s.end) return s;
  }
  return list[list.length - 1];
}

/**
 * Divide o texto da página em frases (com offsets). Parágrafos ('\n') nunca ficam na mesma frase.
 * @param {string} text
 * @param {number} pageNumber
 * @returns {Sentence[]}
 */
export function splitSentences(text, pageNumber) {
  const spans = [];
  let pStart = 0;
  while (pStart <= text.length) {
    let pEnd = text.indexOf('\n', pStart);
    if (pEnd < 0) pEnd = text.length;
    if (pEnd > pStart) spans.push(...splitParagraph(text, pStart, pEnd));
    pStart = pEnd + 1;
  }
  const sentences = [];
  for (const [start, end] of spans) {
    const index = sentences.length;
    sentences.push({
      id: `p${pageNumber}s${index}`,
      pageNumber,
      index,
      text: text.slice(start, end),
      start,
      end,
    });
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// Passo 1: itens → linhas

function itemGeometry(item) {
  const t = item.transform || [1, 0, 0, 1, 0, 0];
  const size = Math.hypot(t[2], t[3]) || item.height || 10;
  const horizontal = Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3;
  return { x: t[4], y: t[5], size, width: item.width || 0, horizontal };
}

function newLine(geo) {
  return {
    text: '',
    parts: [],          // { idx, start, end, src: number[] }
    x0: geo.x,
    x1: geo.x,
    y: geo.y,
    size: geo.size,
    softHyphen: false,  // a linha termina com hífen "mole" (U+00AD)
  };
}

function isSpaceChar(ch) {
  return /\s/u.test(ch) || ch === ' ' || ch === '　';
}

function isDroppedChar(code) {
  return (code < 0x20) ||
    (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff ||
    (code >= 0xe000 && code <= 0xf8ff) || code === 0xfffd;
}

/** Acrescenta os caracteres do item à linha, normalizando espaços. */
function appendItem(line, idx, str) {
  const part = { idx, start: line.text.length, end: line.text.length, src: [] };
  let out = line.text;
  const lastNonSpace = lastNonSpaceIndex(str);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = ch.charCodeAt(0);
    if (ch === '­') {
      // Hífen mole: só vale no fim do item (vira '-' e marca a linha); no meio, some.
      if (i === lastNonSpace) {
        out += '-';
        part.src.push(i);
        line.softHyphen = true;
      }
      continue;
    }
    if (isSpaceChar(ch)) {
      if (out.length === 0 || out[out.length - 1] === ' ') continue;
      out += ' ';
      part.src.push(i);
      continue;
    }
    if (isDroppedChar(code)) continue;
    out += ch;
    part.src.push(i);
    line.softHyphen = false;
  }
  line.text = out;
  part.end = out.length;
  if (part.end > part.start) line.parts.push(part);
}

function lastNonSpaceIndex(str) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (!isSpaceChar(str[i])) return i;
  }
  return -1;
}

function addSeparatorSpace(line) {
  if (line.text.length && line.text[line.text.length - 1] !== ' ') {
    line.text += ' ';
  }
}

function buildLines(items) {
  const lines = [];
  let line = null;
  let prevEOL = false;
  let pendingSpace = false;
  let prev = null; // { str, x, y } do último item com texto (para tirar duplicatas de negrito falso)
  let idx = -1;

  for (const item of items) {
    if (item.str === undefined) continue; // marcação de conteúdo, sem <span> no TextLayer
    idx++;
    const str = item.str;
    const geo = itemGeometry(item);

    if (!str.trim()) {
      // Item só de espaço (ou vazio com hasEOL): vira separador.
      if (line && str.length) pendingSpace = true;
      if (item.hasEOL) prevEOL = true;
      continue;
    }

    let startNew = !line || prevEOL;
    if (!startNew && geo.horizontal) {
      const ref = Math.max(geo.size, line.size);
      const dy = Math.abs(geo.y - line.y);
      const raisedSmall = geo.size < line.size * 0.8 && geo.y > line.y && dy < line.size * 0.75;
      if (dy > ref * 0.6 && !raisedSmall) startNew = true;
    }

    if (!startNew && line) {
      // Negrito simulado: o mesmo texto desenhado de novo quase no mesmo lugar.
      if (prev && prev.str === str && Math.abs(prev.x - geo.x) < geo.size * 0.3 &&
          Math.abs(prev.y - geo.y) < geo.size * 0.3) {
        prevEOL = !!item.hasEOL;
        continue;
      }
      // Nota de rodapé sobrescrita ("texto¹"): não serve para a leitura.
      if (geo.horizontal && geo.size <= line.size * 0.8 && geo.y - line.y > line.size * 0.2 &&
          /^[\d*†‡]{1,3}$/u.test(str.trim())) {
        prevEOL = !!item.hasEOL;
        continue;
      }
    }

    if (startNew) {
      line = newLine(geo);
      lines.push(line);
    } else {
      const ref = Math.max(geo.size, line.size);
      const gap = geo.x - line.x1;
      if (pendingSpace || !geo.horizontal || gap > ref * 0.15 || gap < -ref) {
        addSeparatorSpace(line);
      } else if (line.softHyphen && line.text.endsWith('-')) {
        // Hífen mole seguido de mais texto na mesma linha: some.
        removeLastChar(line);
      }
    }

    appendItem(line, idx, str);
    line.x0 = Math.min(line.x0, geo.x);
    line.x1 = Math.max(line.x1, geo.x + geo.width);
    if (geo.size > line.size && geo.horizontal) {
      // Linha mista: usa o tamanho dominante (o maior) e a base do texto maior.
      line.size = geo.size;
      line.y = geo.y;
    }
    prev = { str, x: geo.x, y: geo.y };
    pendingSpace = false;
    prevEOL = !!item.hasEOL;
  }

  for (const l of lines) trimLineEnd(l);
  return lines.filter((l) => l.text.length > 0);
}

function removeLastChar(line) {
  line.text = line.text.slice(0, -1);
  clampParts(line);
  line.softHyphen = false;
}

function trimLineEnd(line) {
  while (line.text.endsWith(' ')) line.text = line.text.slice(0, -1);
  clampParts(line);
}

function clampParts(line) {
  const len = line.text.length;
  for (const p of line.parts) {
    if (p.end > len) {
      p.src.length = Math.max(0, p.src.length - (p.end - Math.max(len, p.start)));
      p.end = Math.max(len, p.start);
    }
  }
  line.parts = line.parts.filter((p) => p.end > p.start);
}

// ---------------------------------------------------------------------------
// Passo 2: linhas → texto corrido

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function pageStats(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    const dy = a.y - b.y;
    const sameSize = Math.abs(a.size - b.size) <= Math.max(a.size, b.size) * 0.1;
    if (sameSize && dy > 0 && dy < a.size * 3) gaps.push(dy / a.size);
  }
  const widths = lines.filter((l) => l.text.length >= 20).map((l) => l.x1 - l.x0);
  return {
    lineGap: median(gaps) || 1.2,      // entrelinha típica, em múltiplos do tamanho da fonte
    fullWidth: percentile(widths, 0.9), // largura de uma linha "cheia"
  };
}

function isParagraphBreak(prev, cur, stats) {
  const size = Math.max(prev.size, cur.size);
  const dy = prev.y - cur.y;
  if (dy < -size * 0.5) return true; // voltou para cima: outra coluna ou bloco
  if (dy > size * Math.max(stats.lineGap * 1.45, 1.15) && dy > size * 1.15) return true;
  if (Math.max(prev.size, cur.size) / Math.min(prev.size, cur.size) > 1.18) return true; // título
  if (BULLET_START.test(cur.text)) return true; // item de lista
  const shortLine = stats.fullWidth > 0 && (prev.x1 - prev.x0) < stats.fullWidth * 0.65;
  if (shortLine && !/[,;(\-–‐‑]$/u.test(prev.text) && /^[\p{Lu}\d"“«]/u.test(cur.text)) {
    return true; // linha curta sem pontuação seguida de maiúscula: título ou fim de bloco
  }
  return false;
}

function joinLines(lines) {
  const stats = pageStats(lines);
  let text = '';
  const partsWithOffset = [];

  lines.forEach((line, i) => {
    if (i > 0) {
      const prev = lines[i - 1];
      if (isParagraphBreak(prev, line, stats)) {
        text += '\n';
      } else {
        const lastChar = text[text.length - 1];
        // Hífen colado numa letra no fim da linha ("exem-").
        const wordHyphen = HYPHENS.includes(lastChar) && /\p{L}/u.test(text[text.length - 2] || '');
        if (prev.softHyphen || (wordHyphen && shouldJoinHyphen(line.text))) {
          // "exem-" + "plo" → "exemplo": tira o hífen do texto e da faixa do item.
          text = text.slice(0, -1);
          clampGlobalParts(partsWithOffset, text.length);
        } else if (!wordHyphen) {
          text += ' ';
        }
        // Hífen mantido ("Rio-\nGrande"): junta sem espaço.
      }
    }
    const base = text.length;
    text += line.text;
    for (const p of line.parts) {
      partsWithOffset.push({ idx: p.idx, start: base + p.start, end: base + p.end, src: p.src });
    }
  });

  return { text, ranges: buildRanges(partsWithOffset) };
}

function shouldJoinHyphen(nextLine) {
  // Só desfaz o hífen se a próxima linha começa com minúscula e não é um enclítico ("-lhe").
  if (!/^\p{Ll}/u.test(nextLine)) return false;
  const m = /^(\p{Ll}+)(?!\p{L})/u.exec(nextLine);
  return !(m && KEEP_HYPHEN_BEFORE.has(m[1]));
}

function clampGlobalParts(parts, len) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.end <= len) break;
    const newEnd = Math.max(len, p.start);
    p.src = p.src.slice(0, newEnd - p.start);
    p.end = newEnd;
  }
}

function buildRanges(parts) {
  const ranges = [];
  for (const p of parts) {
    if (p.end <= p.start) continue;
    while (ranges.length <= p.idx) ranges.push(null);
    const contiguous = p.src.every((v, k) => v === p.src[0] + k);
    const existing = ranges[p.idx];
    if (existing) {
      // Não deve acontecer (cada item entra numa linha só), mas por garantia mantém o primeiro.
      continue;
    }
    ranges[p.idx] = {
      start: p.start,
      end: p.end,
      srcStart: p.src[0] ?? 0,
      src: contiguous ? null : Int32Array.from(p.src),
    };
  }
  return ranges;
}

function toSource(range, k) {
  return range.src ? range.src[k] : range.srcStart + k;
}

// ---------------------------------------------------------------------------
// Frases

function rawSegments(text, from, to) {
  const chunk = text.slice(from, to);
  const result = [];
  if (sentenceSegmenter) {
    for (const seg of sentenceSegmenter.segment(chunk)) {
      result.push([from + seg.index, from + seg.index + seg.segment.length]);
    }
    return result;
  }
  // Sem Intl.Segmenter: corta depois de . ! ? … (com aspas/parênteses de fechamento) + espaço.
  const re = /[.!?…]+["'”’»)\]]*\s+/gu;
  let last = 0;
  let m;
  while ((m = re.exec(chunk))) {
    const end = m.index + m[0].length;
    result.push([from + last, from + end]);
    last = end;
  }
  if (last < chunk.length) result.push([from + last, to]);
  return result;
}

/** true se o ponto final do segmento não encerra a frase (abreviação, inicial, "1."). */
function endsWithAbbreviation(segText, nextText) {
  const t = segText.trimEnd();
  if (!t.endsWith('.')) return false;
  if (/^\s*\d{1,3}\.$/u.test(t)) return true; // "1." no começo de um item numerado
  const m = /([\p{L}ºª°][\p{L}\p{N}ºª°.]*)\.$/u.exec(t);
  if (!m) return false;
  const token = m[1].toLowerCase();
  if (token.includes('.')) return true;         // "p.ex.", "e.g.", "U.S."
  if (/^\p{L}$/u.test(token)) return /^\s*[\p{L}\p{N}]/u.test(nextText); // inicial: "J. Silva"
  if (ABBREVIATIONS.has(token)) return true;
  return false;
}

function splitParagraph(text, pStart, pEnd) {
  const raw = rawSegments(text, pStart, pEnd);
  // Junta segmentos cortados depois de abreviação ou antes de minúscula.
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last) {
      const lastText = text.slice(last[0], last[1]);
      const segText = text.slice(seg[0], seg[1]);
      if (endsWithAbbreviation(lastText, segText) || /^\s*\p{Ll}/u.test(segText)) {
        last[1] = seg[1];
        continue;
      }
    }
    merged.push([seg[0], seg[1]]);
  }

  const out = [];
  for (let [s, e] of merged) {
    const lead = LEADING_JUNK.exec(text.slice(s, e));
    if (lead) s += lead[0].length;
    while (e > s && /\s/u.test(text[e - 1])) e--;
    if (e <= s) continue;
    const body = text.slice(s, e);
    if (!HAS_ALNUM.test(body)) continue;   // só pontuação/símbolos
    if (ONLY_NUMBER.test(body)) continue;  // número de página solto
    out.push([s, e]);
  }
  return out;
}
