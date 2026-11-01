// Nomes de idiomas em português, para a interface (rótulos, selos e listas).

/** Nomes fixos dos idiomas mais comuns (não dependem do Intl do navegador). */
const NAMES = {
  pt: 'Português',
  en: 'Inglês',
  es: 'Espanhol',
  fr: 'Francês',
  it: 'Italiano',
  de: 'Alemão',
  nl: 'Holandês',
  pl: 'Polonês',
  ru: 'Russo',
  tr: 'Turco',
  ar: 'Árabe',
  he: 'Hebraico',
  hi: 'Hindi',
  ja: 'Japonês',
  zh: 'Chinês',
  ko: 'Coreano',
  sv: 'Sueco',
  da: 'Dinamarquês',
  fi: 'Finlandês',
  no: 'Norueguês',
  nb: 'Norueguês',
  el: 'Grego',
  ms: 'Malaio',
  sw: 'Suaíli',
};

/** Idiomas oferecidos em "Idioma da leitura" quando a voz é a do navegador. */
export const BROWSER_READING_LANGUAGES = Object.freeze(['pt', 'en', 'es', 'fr', 'it', 'de']);

let displayNames = null;
function intlName(code) {
  try {
    displayNames ??= new Intl.DisplayNames(['pt-BR'], { type: 'language' });
    const name = displayNames.of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Código estranho ou navegador sem Intl.DisplayNames.
  }
  return null;
}

/**
 * Código curto do idioma: 'pt-BR' → 'pt', 'en_US' → 'en'.
 * @param {string | null | undefined} lang
 */
export function baseLanguage(lang) {
  return String(lang || '').trim().replace('_', '-').split('-')[0].toLowerCase();
}

/**
 * Nome do idioma em português.
 * - Código curto ('pt') → "Português".
 * - Código com região ('pt-BR') → "Português (Brasil)" quando o navegador sabe o nome.
 * @param {string | null | undefined} lang
 */
export function languageName(lang) {
  const raw = String(lang || '').trim().replace('_', '-');
  if (!raw) return 'Outros idiomas';
  const base = baseLanguage(raw);
  if (raw.includes('-')) return intlName(raw) ?? NAMES[base] ?? raw;
  return NAMES[base] ?? intlName(base) ?? raw;
}

/**
 * Selo curto do idioma, ex.: 'pt' → "PT".
 * @param {string | null | undefined} lang
 */
export function languageBadge(lang) {
  return baseLanguage(lang).toUpperCase();
}
