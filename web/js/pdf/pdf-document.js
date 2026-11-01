// Abre um PDF com o pdf.js e expõe o PdfDoc do contrato (docs/ARQUITETURA.md).
import { getDocument, PasswordResponses, DOCUMENT_OPTIONS } from './pdfjs.js';
import { extractPageText } from './text-extractor.js';

// Quantos textContent brutos ficam em memória (o PageText fica sempre em cache; é leve).
const TEXT_CONTENT_CACHE_SIZE = 16;

const MESSAGES = {
  PASSWORD_REQUIRED: 'Este PDF é protegido por senha. Digite a senha para abrir.',
  PASSWORD_INCORRECT: 'Senha incorreta. Confira e tente de novo.',
  INVALID_PDF: 'Não foi possível abrir: o arquivo não é um PDF válido ou está danificado.',
};

function pdfError(code, cause) {
  const err = new Error(MESSAGES[code], cause ? { cause } : undefined);
  err.code = code;
  return err;
}

/**
 * Abre um PDF.
 * @param {File|Blob|ArrayBuffer|Uint8Array} source
 * @param {{ password?: string }} [options]
 * @returns {Promise<PdfDoc>}
 * @throws {Error} com `.code`: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT' | 'INVALID_PDF'
 */
export async function openPdf(source, { password } = {}) {
  let data;
  let fileName = '';
  try {
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      data = new Uint8Array(await source.arrayBuffer());
      fileName = source.name || '';
    } else if (source instanceof ArrayBuffer) {
      // Cópia: o pdf.js transfere o buffer para o worker, e o chamador pode querer reabrir.
      data = new Uint8Array(source.slice(0));
    } else if (ArrayBuffer.isView(source)) {
      data = new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    } else {
      throw new TypeError('Fonte de PDF não suportada.');
    }
  } catch (err) {
    throw pdfError('INVALID_PDF', err);
  }

  const params = { ...DOCUMENT_OPTIONS, data };
  if (password != null && password !== '') params.password = password;
  const loadingTask = getDocument(params);

  let raw;
  try {
    raw = await loadingTask.promise;
  } catch (err) {
    loadingTask.destroy().catch(() => {});
    if (err?.name === 'PasswordException') {
      const code = err.code === PasswordResponses.INCORRECT_PASSWORD
        ? 'PASSWORD_INCORRECT'
        : 'PASSWORD_REQUIRED';
      throw pdfError(code, err);
    }
    throw pdfError('INVALID_PDF', err);
  }

  const title = await readTitle(raw, fileName);
  return new PdfDoc(raw, { title, fileName });
}

async function readTitle(raw, fileName) {
  const fromFile = fileName.replace(/\.pdf$/i, '').trim();
  let candidate = '';
  try {
    const { info, metadata } = await raw.getMetadata();
    candidate = (metadata?.get('dc:title') || info?.Title || '').toString();
  } catch {
    candidate = '';
  }
  candidate = candidate.replace(/\s+/g, ' ').trim();
  const useless = !candidate ||
    /^(untitled|sem t[ií]tulo|documento?\d*|title|t[ií]tulo)$/i.test(candidate) ||
    /^microsoft (word|powerpoint|excel) - /i.test(candidate) ||
    /\.(docx?|odt|rtf|pptx?|xlsx?|tex|dvi|indd|qxd|pdf|ps)$/i.test(candidate);
  if (!useless) return candidate;
  return fromFile || 'Documento sem título';
}

/** Documento aberto. Use `openPdf()` para criar. */
export class PdfDoc {
  #pageTexts = new Map();     // n → Promise<PageText>
  #textContents = new Map();  // n → Promise<textContent> (LRU)
  #destroyed = false;

  constructor(raw, { title, fileName }) {
    /** PDFDocumentProxy do pdf.js (uso interno do módulo PDF). */
    this.raw = raw;
    this.numPages = raw.numPages;
    this.title = title;
    this.fileName = fileName;
    this.fingerprint = raw.fingerprints?.[0] || `${fileName}:${raw.numPages}`;
  }

  /**
   * Texto da página já normalizado e dividido em frases (com cache).
   * Se a página não puder ser lida, devolve uma página vazia em vez de falhar.
   * @param {number} n 1-based
   * @returns {Promise<PageText>}
   */
  getPageText(n) {
    try {
      this.#checkPage(n);
    } catch (err) {
      return Promise.reject(err);
    }
    let promise = this.#pageTexts.get(n);
    if (!promise) {
      promise = this.#loadTextContent(n)
        .then((textContent) => extractPageText(textContent, n))
        .catch((err) => {
          if (this.#destroyed) throw err;
          console.warn(`Não foi possível ler o texto da página ${n}.`, err);
          this.#pageTexts.delete(n);
          return extractPageText({ items: [] }, n);
        });
      this.#pageTexts.set(n, promise);
    }
    return promise;
  }

  /**
   * Uso interno do módulo PDF (viewer): textContent bruto + PageText da mesma página.
   * Os índices dos itens batem com os <span> criados pelo TextLayer do pdf.js.
   * @param {number} n
   * @returns {Promise<{ textContent: object, pageText: PageText }>}
   */
  async getTextData(n) {
    this.#checkPage(n);
    const [textContent, pageText] = await Promise.all([this.#loadTextContent(n), this.getPageText(n)]);
    return { textContent, pageText };
  }

  async destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#pageTexts.clear();
    this.#textContents.clear();
    try {
      await this.raw.destroy();
    } catch {
      // já destruído
    }
  }

  #checkPage(n) {
    if (this.#destroyed) throw new Error('O documento já foi fechado.');
    if (!Number.isInteger(n) || n < 1 || n > this.numPages) {
      throw new RangeError(`Página ${n} não existe (o documento tem ${this.numPages}).`);
    }
  }

  #loadTextContent(n) {
    const cache = this.#textContents;
    let promise = cache.get(n);
    if (promise) {
      cache.delete(n); // reinsere no fim (mais recente)
      cache.set(n, promise);
      return promise;
    }
    // Parâmetros padrão do getTextContent: os mesmos itens que o TextLayer vai desenhar.
    promise = this.raw.getPage(n).then((page) => page.getTextContent());
    promise.catch(() => cache.delete(n));
    cache.set(n, promise);
    while (cache.size > TEXT_CONTENT_CACHE_SIZE) {
      cache.delete(cache.keys().next().value);
    }
    return promise;
  }
}
