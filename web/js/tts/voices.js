// Vozes do navegador: normalização, ordenação (pt-BR primeiro) e escolha da voz padrão.

/**
 * @typedef {{ id: string, name: string, lang: string, localService: boolean, isDefault: boolean }} Voice
 */

// Nomes que costumam indicar vozes de melhor qualidade (online/neurais).
const QUALITY_RE = /natural|neural|online|google|premium|enhanced|wavenet|aprimorad/i;

/** Id estável de uma SpeechSynthesisVoice (voiceURI; cai para o nome se vier vazio). */
export function voiceIdOf(native) {
  return String(native?.voiceURI || native?.name || '');
}

/** 'pt_br' → 'pt-BR', 'PT' → 'pt', 'por-BRA' → 'pt-BR'. */
export function normalizeLang(lang) {
  const parts = String(lang || '').trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (!parts.length) return '';
  let base = parts[0].toLowerCase();
  if (base === 'por') base = 'pt';
  let region = parts[1] ? parts[1].toUpperCase() : '';
  if (region === 'BRA') region = 'BR';
  if (region === 'PRT') region = 'PT';
  return region ? `${base}-${region}` : base;
}

/**
 * Converte SpeechSynthesisVoice → Voice. Devolve null se a voz não tiver id.
 * @returns {Voice|null}
 */
export function normalizeVoice(native) {
  const id = voiceIdOf(native);
  if (!id) return null;
  return {
    id,
    name: String(native.name || id),
    lang: normalizeLang(native.lang),
    localService: native.localService !== false,
    isDefault: Boolean(native.default),
  };
}

/** 0 = pt-BR, 1 = outro português, 2 = resto. */
export function langRank(lang) {
  const l = normalizeLang(lang);
  if (l === 'pt-BR') return 0;
  if (l === 'pt' || l.startsWith('pt-')) return 1;
  return 2;
}

/** 0 = voz natural/online, 1 = voz local comum. */
export function qualityRank(voice) {
  return QUALITY_RE.test(voice.name) || voice.localService === false ? 0 : 1;
}

/**
 * Remove duplicadas e ordena: pt-BR, depois pt-*, depois o resto; em cada grupo,
 * as naturais/online primeiro, depois a padrão do sistema, depois por nome.
 * @param {Voice[]} voices
 * @returns {Voice[]}
 */
export function sortVoices(voices) {
  const seen = new Set();
  const unique = [];
  for (const v of voices) {
    if (!v || !v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    unique.push(v);
  }
  return unique.sort((a, b) =>
    langRank(a.lang) - langRank(b.lang)
    || qualityRank(a) - qualityRank(b)
    || Number(b.isDefault) - Number(a.isDefault)
    || a.name.localeCompare(b.name, 'pt-BR'));
}

/** Só o idioma, sem região: 'pt-BR' → 'pt', 'EN_us' → 'en'. */
export function langBase(lang) {
  return normalizeLang(lang).split('-')[0];
}

/** true se a voz fala o idioma (comparando só a base: 'pt-PT' fala 'pt'). */
export function voiceSpeaks(voice, lang) {
  const base = langBase(lang);
  return Boolean(voice && base) && langBase(voice.lang) === base;
}

// Região preferida quando há várias vozes do mesmo idioma.
const PREFERRED_REGION = { pt: 'BR', en: 'US', es: 'ES', fr: 'FR', it: 'IT', de: 'DE' };

/**
 * Melhor voz para um idioma: a região pedida/do sistema (`navigatorLanguages`) ou a
 * preferida (pt-BR, en-US...) primeiro, depois as naturais/online, depois a padrão do sistema.
 * @param {Voice[]} voices
 * @param {string} lang 'pt', 'en', 'pt-BR'...
 * @param {{ navigatorLanguages?: readonly string[] }} [options]
 * @returns {Voice|null} null se nenhuma voz fala o idioma
 */
export function pickVoiceForLang(voices, lang, { navigatorLanguages = globalThis.navigator?.languages ?? [] } = {}) {
  const base = langBase(lang);
  if (!base || !voices?.length) return null;
  const candidates = voices.filter((v) => langBase(v.lang) === base);
  if (!candidates.length) return null;
  const wantedRegion = normalizeLang(lang).split('-')[1]
    || (navigatorLanguages || []).map(normalizeLang).find((l) => l.startsWith(`${base}-`))?.split('-')[1]
    || PREFERRED_REGION[base]
    || '';
  const regionRank = (v) => (wantedRegion && normalizeLang(v.lang).split('-')[1] === wantedRegion ? 0 : 1);
  return [...candidates].sort((a, b) =>
    regionRank(a) - regionRank(b)
    || qualityRank(a) - qualityRank(b)
    || Number(b.isDefault) - Number(a.isDefault)
    || a.name.localeCompare(b.name, 'pt-BR'))[0];
}

/**
 * Escolhe a voz padrão: a salva (se ainda existe) > melhor pt-BR > melhor pt-* >
 * padrão do sistema > primeira da lista.
 * @param {Voice[]} voices lista já ordenada por sortVoices
 * @param {string|null} [savedId]
 * @returns {Voice|null}
 */
export function pickDefaultVoice(voices, savedId = null) {
  if (!voices || !voices.length) return null;
  if (savedId) {
    const saved = voices.find((v) => v.id === savedId);
    if (saved) return saved;
  }
  return voices.find((v) => langRank(v.lang) === 0)
    || voices.find((v) => langRank(v.lang) === 1)
    || voices.find((v) => v.isDefault)
    || voices[0];
}
