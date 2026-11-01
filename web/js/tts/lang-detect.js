// Detecção de idioma sem dependências, pensada para texto de PDF (páginas e frases).
//
// Como funciona:
// 1. Escritas não latinas são decididas pela faixa Unicode: kana → ja, ideogramas (sem kana)
//    → zh, devanágari → hi, hangul → ko, cirílico → ru (aproximação).
// 2. Para pt, en, es, fr, it e de soma pontos de duas fontes:
//    - palavras funcionais frequentes (artigos, preposições, pronomes, verbos auxiliares).
//      Uma palavra que existe em vários idiomas ("de", "la", "que") vale menos, dividida
//      entre eles;
//    - sinais ortográficos (ã/õ/ç/"ção" → pt; ñ/¿/¡/"ción" → es; ß/ä/ö/ü → de; œ/"qu'" → fr;
//      "zione"/"gli"/ò/ì → it; "the"/"'s"/"ing" → en...).
// 3. A confiança junta a margem entre o 1º e o 2º colocado e a quantidade de evidência.
//    Texto curto ou empatado → `fallback` (se houver) ou null.

const SUPPORTED = ['pt', 'en', 'es', 'fr', 'it', 'de'];

// Palavras funcionais. Palavras repetidas entre idiomas são divididas automaticamente.
// Peso 2 (prefixo "!") para palavras muito típicas daquele idioma.
const WORDS = {
  pt: `de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao
    ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela
    entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num
    nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho lhe deles essas esses
    pelas este fosse dele vocês lhes meus minhas teu tua nosso nossa nossos nossas isto aquilo aquele
    aquela são estava pode podem fazer então ainda bem porque sobre assim aqui onde cada sempre
    ela uns umas vai vão fazer feito estes estas algo alguns algumas muitos muitas outro outra
    outros outras todo toda todos todas tudo nada ninguém agora antes durante sendo sido seria
    deve devem através contra desde sob após`,
  es: `de la que el en y a los las del se por un una con no es para al lo como más pero sus su le
    ya o este esta sí porque muy sin sobre también me hasta hay donde quien desde todo nos durante
    todos uno les ni contra otros ese eso ante ellos esto mí antes algunos qué unos yo otro otras
    otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo
    nosotros mi mis tú te ti tu tus ellas son ser fue era está han ha hace puede pueden cuando
    entre tiene tienen hacer bien así aquí cómo también pues aunque según sino tras hacia mientras
    después ahora siempre todavía cada vez`,
  fr: `le la les de des du et est un une en que qui dans pour pas ne sur au aux avec ce cette ces
    il elle ils elles nous vous je se sont plus par mais ou comme été être avoir son sa ses leur
    leurs on tout tous toute toutes aussi très fait peut était ont même sans entre y lui dont où
    quand avait sont cela ceci celui celle notre nos votre vos mon ma mes ton ta tes leur déjà
    encore alors donc car si bien peu après avant depuis sous chez vers moins tant`,
  it: `il di che e la un una per non sono del della delle dei degli gli le lo in con si da al
    alla alle ai agli nel nella nelle nei negli è ma come anche più questo questa questi queste
    quello quella ha hanno essere stato stata era o se mi ci ne cosa molto tutto tutti dopo già
    sempre perché quando solo loro suo sua suoi io tu lui lei noi voi sul sulla dal dalla tra fra
    ancora dove mentre però quindi cioè ogni senza stesso proprio fatto può possono erano cui poi
    così qui fino uno essa esso`,
  de: `der die das und ist nicht ein eine einen einem einer zu den dem des von mit sich auf für
    im es auch als an wie ich er sie wir ihr aber nach bei noch wird werden sind war hat haben oder
    wenn dass nur kann so aus um über durch mehr schon sehr diese dieser dieses man vor zum zur
    wurde wurden sein seine ihre ihren ihrem kein keine nicht doch also hier dann denn weil gegen
    ohne unter zwischen bis immer alle alles etwas jetzt ganz`,
  en: `the and of to in is that it for with as was on are be this by have from or at not but an
    they which you his her we can has were will would there their what about if more when who so
    been one all also into than its only other some these them may should could our out how no do
    does did he she i my your had any after over such those then most must where very just between
    through being under while`,
};

// Palavras com peso extra (bem características do idioma).
const STRONG = {
  pt: 'não uma você também são então muito isso pelo pela ao às dos das nós ele ela eles elas foi há seu sua mais um em com os do da no na está estão tem têm',
  es: 'el los las del y en con una muy más pero también él ella ellos yo hay fue esto eso hasta desde donde cuando tiene son es al su sus lo',
  fr: 'le les des du et est une dans pour pas ne sur au aux avec ce cette il ils nous vous je sont été être avoir très qui',
  it: 'il di che è della delle degli gli per non sono del nella questo questa anche più hanno essere molto perché',
  de: 'der die das und ist nicht ein eine zu den dem des von mit sich auf für im auch wird werden sind hat haben dass ich',
  en: 'the and of to is that it for with was on are be this by have from which they you were would their what',
};

// Sinais ortográficos: [regex, { idioma: pontos por ocorrência }].
const ORTHO = [
  [/[ãõ]/g, { pt: 2.5 }],
  [/ç[ãõ]/g, { pt: 2 }],
  [/ç/g, { pt: 0.6, fr: 0.5 }],
  [/\p{L}(?:nh|lh)\p{L}/gu, { pt: 0.6 }],
  [/\p{L}(?:dade|dades|agem|agens|eiro|eira|mente)\b/gu, { pt: 0.3 }],
  // pretérito "-ou" (falou, anunciou) e "-aram/-eram" são bem portugueses
  [/\p{L}{2}ou\b/gu, { pt: 0.8 }],
  [/\p{L}{2}(?:aram|eram|iram|avam|ava)\b/gu, { pt: 0.6 }],
  [/\p{L}{2}(?:aron|ieron|aba|aban)\b/gu, { es: 0.6 }],
  [/[ñ]/g, { es: 2.5 }],
  [/[¿¡]/g, { es: 3 }],
  [/ci[oó]n\b|ciones\b/g, { es: 1.5 }],
  [/\p{L}(?:dad|dades)\b/gu, { es: 0.6 }],
  [/\p{L}ll\p{L}/gu, { es: 0.3, fr: 0.15, it: 0.15 }],
  [/ü/g, { de: 1.5 }],
  [/[äö]/g, { de: 2 }],
  [/ß/g, { de: 3 }],
  [/sch/g, { de: 1 }],
  [/\p{L}(?:ung|ungen|keit|heit|lich|lichen|isch)\b/gu, { de: 1 }],
  [/œ/g, { fr: 3 }],
  [/[ëïîû]/g, { fr: 1.5 }],
  [/[èàù]/g, { fr: 0.4, it: 0.4 }],
  [/\b(?:qu|n|j|c|s|d|m|t)['’]\p{L}/gu, { fr: 1.2 }],
  [/\bl['’]\p{L}/gu, { fr: 0.6 }],
  [/\b(?:dell|nell|all|dall|sull|quest|un|l)['’]\p{L}/gu, { it: 0.8 }],
  [/eau|eux\b|aux\b/g, { fr: 0.4 }],
  [/[òì]/g, { it: 1.5 }],
  [/zion[ei]\b/g, { it: 2 }],
  [/\bgli\b|\p{L}gli\p{L}|\p{L}(?:zz|cch|gg|cci)\p{L}/gu, { it: 0.5 }],
  [/\p{L}{2}(?:are|ere|ire|ato|ata|ati|uto|ito|eva|evano)\b/gu, { it: 0.4 }],
  [/\p{L}(?:ing|ings)\b/gu, { en: 0.6 }],
  [/th/g, { en: 0.4 }],
  [/\p{L}['’](?:s|t|re|ve|ll|d|m)\b/gu, { en: 1 }],
  [/\b\p{L}+n['’]t\b/gu, { en: 1 }],
  [/w/g, { en: 0.25, de: 0.15 }],
  [/k/g, { de: 0.15, en: 0.05 }],
];

// Clíticos ligados por hífen (encontrá-la, disse-lhe): não contam como palavra solta.
const CLITICS = new Set(['o', 'a', 'os', 'as', 'lo', 'la', 'los', 'las', 'no', 'na', 'nos', 'nas', 'se', 'me', 'te', 'lhe', 'lhes', 'vos']);

const MAX_SAMPLE = 6000;
const MIN_LETTERS = 12;
const MIN_EVIDENCE = 1.2;
const SCRIPT_SHARE = 0.3;

/** @type {Map<string, Record<string, number>>} palavra → { idioma: peso } */
const WORD_WEIGHTS = buildWordWeights();

function buildWordWeights() {
  const owners = new Map();
  for (const [lang, list] of Object.entries(WORDS)) {
    for (const w of new Set(list.split(/\s+/).filter(Boolean))) {
      if (!owners.has(w)) owners.set(w, new Set());
      owners.get(w).add(lang);
    }
  }
  const strong = {};
  for (const [lang, list] of Object.entries(STRONG)) strong[lang] = new Set(list.split(/\s+/));
  const weights = new Map();
  for (const [w, langs] of owners) {
    const share = 1 / langs.size ** 1.5;
    const entry = {};
    for (const lang of langs) entry[lang] = share * (strong[lang].has(w) ? 2 : 1);
    weights.set(w, entry);
  }
  return weights;
}

/** Idioma pela escrita (não latina) ou null. */
function detectScript(text) {
  let latin = 0;
  let kana = 0;
  let han = 0;
  let deva = 0;
  let hangul = 0;
  let cyr = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin += 1;
    else if (c >= 0x3040 && c <= 0x30ff) kana += 1;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) han += 1;
    else if (c >= 0x0900 && c <= 0x097f) deva += 1;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff)) hangul += 1;
    else if (c >= 0x0400 && c <= 0x04ff) cyr += 1;
  }
  // Um ideograma ou kana "vale" mais que uma letra latina (é uma sílaba/palavra).
  const cjk = (kana + han) * 2;
  const total = latin + cjk + deva + hangul * 2 + cyr;
  if (!total) return null;
  const pick = (lang, count) => ({ lang, confidence: round(Math.min(1, count / total) * Math.min(1, count / 8)) });
  if (cjk / total >= SCRIPT_SHARE) {
    // japonês mistura kana com kanji; chinês não tem kana
    if (kana >= 2 || (kana && kana * 4 >= han)) return pick('ja', cjk);
    return pick('zh', cjk);
  }
  if (deva / total >= SCRIPT_SHARE) return pick('hi', deva);
  if ((hangul * 2) / total >= SCRIPT_SHARE) return pick('ko', hangul * 2);
  if (cyr / total >= SCRIPT_SHARE) return pick('ru', cyr);
  return null;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Pontuação de cada idioma latino. */
function scoreLatin(text) {
  const scores = Object.fromEntries(SUPPORTED.map((l) => [l, 0]));
  let words = 0;
  const re = /[\p{L}]+(?:['’][\p{L}]+)?/gu;
  let m;
  while ((m = re.exec(text))) {
    let w = m[0];
    // "l'homme" / "dell'anno": o pedaço antes do apóstrofo é tratado pelos sinais ortográficos
    const apo = w.search(/['’]/);
    if (apo >= 0) w = w.slice(apo + 1);
    words += 1;
    if (m.index > 0 && text[m.index - 1] === '-' && CLITICS.has(w)) continue;
    const entry = WORD_WEIGHTS.get(w);
    if (!entry) continue;
    for (const lang in entry) scores[lang] += entry[lang];
  }
  for (const [re2, gains] of ORTHO) {
    re2.lastIndex = 0;
    const count = (text.match(re2) || []).length;
    if (!count) continue;
    for (const lang in gains) scores[lang] += gains[lang] * count;
  }
  return { scores, words };
}

/**
 * Detecta o idioma do texto.
 * @param {string} text
 * @param {{ fallback?: string|null }} [options] idioma a devolver quando o texto é curto ou
 *   ambíguo (com confidence 0); também desempata a favor dele quando está quase empatado.
 * @returns {{ lang: string, confidence: number } | null} lang: 'pt'|'en'|'es'|'fr'|'it'|'de'
 *   ou, por escrita, 'ja'|'zh'|'hi'|'ko'|'ru'. null se indeciso e sem fallback.
 */
export function detectLanguage(text, { fallback = null } = {}) {
  const fb = fallback ? String(fallback).toLowerCase().slice(0, 2) : null;
  const undecided = () => (fb ? { lang: fb, confidence: 0 } : null);

  let src = String(text ?? '');
  if (src.length > MAX_SAMPLE) {
    // amostra do começo, do meio e do fim (páginas longas)
    const third = Math.floor(MAX_SAMPLE / 3);
    const mid = Math.floor(src.length / 2 - third / 2);
    src = `${src.slice(0, third)} ${src.slice(mid, mid + third)} ${src.slice(-third)}`;
  }
  src = src.normalize('NFC')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ');

  const script = detectScript(src);
  if (script) return script.confidence > 0 || !fb ? script : undecided();

  const lower = src.toLowerCase();
  const letters = (lower.match(/\p{L}/gu) || []).length;
  if (letters < MIN_LETTERS) return undecided();

  const { scores, words } = scoreLatin(lower);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[best, s1], [, s2]] = ranked;
  if (s1 < MIN_EVIDENCE) return undecided();

  const margin = (s1 - s2) / s1;
  // evidência: pontos por palavra (texto longo com poucos acertos é suspeito)
  const density = Math.min(1, s1 / Math.max(4, words * 0.6));
  const amount = Math.min(1, s1 / 8);
  let confidence = round(Math.min(1, margin * 1.6) * (0.4 + 0.6 * amount) * (0.5 + 0.5 * density));

  if (fb && fb !== best && scores[fb] !== undefined && scores[fb] >= s1 * 0.8) {
    return { lang: fb, confidence: round(confidence * 0.5) };
  }
  if (margin < 0.12) return undecided();
  confidence = Math.max(confidence, 0.05);
  return { lang: best, confidence };
}

/** Idiomas que a heurística sabe distinguir pelas palavras. */
export const DETECTABLE_LANGUAGES = [...SUPPORTED, 'ja', 'zh', 'hi', 'ko', 'ru'];
