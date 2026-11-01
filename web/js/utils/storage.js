// Guarda ajustes e a posição de leitura no localStorage.
// Todo acesso fica em try/catch: em janela anônima, com cookies bloqueados ou com
// o armazenamento cheio, o app continua funcionando, só não lembra das coisas.

const PREFIX = 'leitor-pdf:';
const KEY_VOICE = 'voice';
const KEY_THEME = 'theme';
const KEY_POSITIONS = 'positions';
const KEY_ENGINE = 'engine';

/** Quantos PDFs, no máximo, têm a posição de leitura guardada. */
export const MAX_SAVED_POSITIONS = 50;

/** Valores padrão dos ajustes de voz. */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  voiceId: null,
  rate: 1,
  pitch: 1,
  volume: 1,
});

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Sem armazenamento: nada a remover.
  }
}

function numberIn(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Lê os ajustes de voz salvos (sempre devolve um objeto completo e válido).
 * @returns {{ voiceId: string | null, rate: number, pitch: number, volume: number }}
 */
export function loadVoiceSettings() {
  const saved = read(KEY_VOICE, null);
  const data = saved && typeof saved === 'object' ? saved : {};
  return {
    voiceId: typeof data.voiceId === 'string' && data.voiceId ? data.voiceId : null,
    rate: numberIn(data.rate, 0.5, 2.5, DEFAULT_VOICE_SETTINGS.rate),
    pitch: numberIn(data.pitch, 0, 2, DEFAULT_VOICE_SETTINGS.pitch),
    volume: numberIn(data.volume, 0, 1, DEFAULT_VOICE_SETTINGS.volume),
  };
}

/**
 * Salva parte dos ajustes de voz (mescla com o que já existe).
 * @param {Partial<{ voiceId: string | null, rate: number, pitch: number, volume: number }>} partial
 */
export function saveVoiceSettings(partial) {
  return write(KEY_VOICE, { ...loadVoiceSettings(), ...partial });
}

/** Idioma da leitura: 'auto' ou um código curto ('pt', 'en', 'zh'...). */
const LANGUAGE_RE = /^[a-z]{2,3}$/;
/** Ids de motor/voz vindos do servidor (ex.: 'kokoro', 'kokoro:pf_dora'). */
const ID_RE = /^[\w.:@-]{1,120}$/;

/** Valores padrão da escolha de motor (versão 2). */
export const DEFAULT_ENGINE_SETTINGS = Object.freeze({
  engine: null,
  neuralModel: null,
  neuralVoiceId: null,
  language: 'auto',
});

/**
 * Escolha de motor de voz e idioma (sempre devolve um objeto completo e válido).
 * - engine: 'neural' | 'browser' | null (null = automático: voz de IA se o servidor responder)
 * - neuralModel: motor neural escolhido no servidor (ex.: 'kokoro') ou null (padrão do servidor)
 * - neuralVoiceId: voz da IA (a voz do navegador continua em loadVoiceSettings().voiceId)
 * - language: 'auto' ou idioma fixo
 * @returns {{ engine: 'neural' | 'browser' | null, neuralModel: string | null, neuralVoiceId: string | null, language: string }}
 */
export function loadEngineSettings() {
  const saved = read(KEY_ENGINE, null);
  const data = saved && typeof saved === 'object' ? saved : {};
  const id = (value) => (typeof value === 'string' && ID_RE.test(value) ? value : null);
  return {
    engine: data.engine === 'neural' || data.engine === 'browser' ? data.engine : null,
    neuralModel: id(data.neuralModel),
    neuralVoiceId: id(data.neuralVoiceId),
    language: typeof data.language === 'string' && LANGUAGE_RE.test(data.language) ? data.language : 'auto',
  };
}

/**
 * Salva parte da escolha de motor (mescla com o que já existe).
 * @param {Partial<ReturnType<typeof loadEngineSettings>>} partial
 */
export function saveEngineSettings(partial) {
  return write(KEY_ENGINE, { ...loadEngineSettings(), ...partial });
}

/**
 * Tema escolhido pelo usuário, ou null para seguir o sistema.
 * @returns {'light' | 'dark' | null}
 */
export function loadTheme() {
  const theme = read(KEY_THEME, null);
  return theme === 'light' || theme === 'dark' ? theme : null;
}

/**
 * @param {'light' | 'dark' | null} theme null volta a seguir o sistema
 */
export function saveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return write(KEY_THEME, theme);
  remove(KEY_THEME);
  return true;
}

function readPositions() {
  const data = read(KEY_POSITIONS, null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * Posição de leitura salva para um PDF.
 * @param {string} fingerprint
 * @returns {{ pageNumber: number, sentenceIndex: number, updatedAt: number } | null}
 */
export function loadPosition(fingerprint) {
  if (!fingerprint) return null;
  const entry = readPositions()[fingerprint];
  if (!entry || typeof entry !== 'object') return null;
  const pageNumber = Math.trunc(Number(entry.pageNumber));
  const sentenceIndex = Math.trunc(Number(entry.sentenceIndex));
  if (!(pageNumber >= 1) || !(sentenceIndex >= 0)) return null;
  return { pageNumber, sentenceIndex, updatedAt: Number(entry.updatedAt) || 0 };
}

/**
 * Salva a posição de leitura de um PDF. Mantém só os MAX_SAVED_POSITIONS mais recentes.
 * @param {string} fingerprint
 * @param {{ pageNumber: number, sentenceIndex: number }} position
 */
export function savePosition(fingerprint, { pageNumber, sentenceIndex }) {
  if (!fingerprint) return false;
  const positions = readPositions();
  positions[fingerprint] = { pageNumber, sentenceIndex, updatedAt: Date.now() };

  const keys = Object.keys(positions);
  if (keys.length > MAX_SAVED_POSITIONS) {
    keys
      .sort((a, b) => (Number(positions[b]?.updatedAt) || 0) - (Number(positions[a]?.updatedAt) || 0))
      .slice(MAX_SAVED_POSITIONS)
      .forEach((key) => delete positions[key]);
  }
  return write(KEY_POSITIONS, positions);
}

/**
 * Esquece a posição de um PDF (por exemplo, ao terminar de ler).
 * @param {string} fingerprint
 */
export function clearPosition(fingerprint) {
  if (!fingerprint) return false;
  const positions = readPositions();
  if (!(fingerprint in positions)) return true;
  delete positions[fingerprint];
  return write(KEY_POSITIONS, positions);
}
