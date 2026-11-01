// Carrega o pdf.js (versão fixa) do CDN jsDelivr e configura o worker.
// Único ponto do projeto que conhece as URLs do pdf.js.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';

// Worker em outra origem: o pdf.js cria sozinho um wrapper (blob com import()) para ele.
pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN_BASE}build/pdf.worker.min.mjs`;

/** Opções padrão de getDocument (CMaps para PDFs com fontes CJK e fontes padrão do PDF). */
export const DOCUMENT_OPTIONS = Object.freeze({
  cMapUrl: `${CDN_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${CDN_BASE}standard_fonts/`,
  isEvalSupported: false,
  verbosity: pdfjsLib.VerbosityLevel.ERRORS, // sem avisos internos do pdf.js no console
});

export const {
  getDocument,
  TextLayer,
  PasswordResponses,
  RenderingCancelledException,
  AbortException,
  version,
} = pdfjsLib;

export { pdfjsLib };
