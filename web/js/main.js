// Ponto de entrada: liga o módulo PDF, o módulo de Voz e a interface.
// Contrato entre os módulos: docs/ARQUITETURA.md.
//
// Versão 2: há dois motores de voz com a mesma interface.
// - Voz de IA (NeuralSpeechEngine): gerada pelo servidor local (`python -m servidor`).
// - Voz do navegador (SpeechEngine): Web Speech API, como na versão 1.
// Na partida, se o servidor responder e tiver um modelo disponível, a voz de IA é a padrão.

import { SpeechEngine } from './tts/speech-engine.js';
import { ReadingSession } from './tts/reading-session.js';
import { Toolbar } from './ui/toolbar.js';
import { PlayerBar } from './ui/player-bar.js';
import { SettingsPanel } from './ui/settings-panel.js';
import { setupFileDrop, isPdfFile } from './ui/file-drop.js';
import { Toaster } from './ui/toast.js';
import { byId, debounce, isActivatable, isTextEntry } from './utils/dom.js';
import { BROWSER_READING_LANGUAGES, baseLanguage, languageName } from './utils/languages.js';
import {
  DEFAULT_VOICE_SETTINGS,
  clearPosition,
  loadEngineSettings,
  loadPosition,
  loadTheme,
  loadVoiceSettings,
  saveEngineSettings,
  savePosition,
  saveTheme,
  saveVoiceSettings,
} from './utils/storage.js';

const APP_NAME = 'Leitor de PDF com Voz';
/** Quantas páginas iniciais olhar para decidir se o PDF parece escaneado. */
const SCAN_CHECK_PAGES = 3;
const SAVE_POSITION_DELAY = 1000;
/** Tempo máximo esperando o servidor de voz responder na partida. */
const NEURAL_PROBE_TIMEOUT = 4000;
/** Ao abrir os ajustes, confere de novo o servidor se a última conferência foi há mais que isto. */
const NEURAL_RECHECK_AFTER = 5000;
/** Espera antes de mostrar "Carregando voz de IA…" (modelo ainda não carregado / já carregado). */
const VOICE_WAIT_COLD = 600;
const VOICE_WAIT_WARM = 2500;

const ACTIVE_STATES = ['playing', 'paused', 'loading'];
/** Erros da sessão que não são culpa do motor de voz (não oferecem trocar de motor). */
const NON_ENGINE_ERRORS = ['NO_TEXT', 'PAGE_TEXT_FAILED'];

const TEST_PHRASES = {
  pt: 'Olá! Esta é a voz que vai ler o seu PDF.',
  en: 'Hello! This is the voice that will read your PDF.',
  es: '¡Hola! Esta es la voz que leerá tu PDF.',
  fr: 'Bonjour ! Voici la voix qui va lire votre PDF.',
  it: 'Ciao! Questa è la voce che leggerà il tuo PDF.',
  de: 'Hallo! Diese Stimme liest dein PDF vor.',
  hi: 'नमस्ते! यह वह आवाज़ है जो आपका PDF पढ़ेगी।',
  ja: 'こんにちは。これがあなたのPDFを読む声です。',
  zh: '你好！这是为你朗读PDF的声音。',
};

const START_SERVER_TIP = 'Para ligar, rode scripts\\iniciar.bat e toque em “Verificar de novo” nos ajustes.';

// ---------- Elementos ----------
const els = {
  fileInput: byId('file-input'),
  openButton: byId('btn-open'),
  welcomeOpenButton: byId('btn-welcome-open'),
  welcome: byId('welcome'),
  viewer: byId('viewer'),
  toastRegion: byId('toast-region'),
  dropOverlay: byId('drop-overlay'),
  passwordDialog: /** @type {HTMLDialogElement} */ (byId('password-dialog')),
  passwordMessage: byId('password-message'),
  passwordFile: byId('password-file'),
  passwordInput: /** @type {HTMLInputElement} */ (byId('password-input')),
  passwordCancel: byId('password-cancel'),
};

// ---------- Estado da aplicação ----------
const state = {
  /** @type {any} PdfDoc aberto */
  doc: null,
  /** @type {any} PdfViewer (criado na primeira abertura) */
  viewer: null,
  /** @type {any} motor em uso (SpeechEngine ou NeuralSpeechEngine); null se nenhum está disponível */
  engine: null,
  /** Motores já criados (reaproveitados ao trocar de um para o outro). */
  engines: { browser: null, neural: null },
  /** Promessas de criação dos motores (evita criar dois iguais ao mesmo tempo). */
  enginePromises: { browser: null, neural: null },
  /** Aumenta a cada troca de motor; descarta trocas antigas. */
  engineToken: 0,
  /** Desliga os ouvintes do motor anterior. */
  engineAbort: null,
  /** false enquanto a partida ainda está escolhendo o motor. */
  speechReady: false,
  browserSupported: false,
  /** Voz de IA: resultado da última conferência do servidor. */
  neural: {
    /** Classe NeuralSpeechEngine (carregada sob demanda). */
    Ctor: null,
    /** Resposta de GET /api/tts/status (ou null). */
    status: null,
    available: false,
    /** Motivo, em pt-BR, quando indisponível (começa com letra minúscula). */
    reason: '',
    checking: false,
    checkedAt: 0,
    /** true enquanto o modelo está carregando (evento 'loadingmodel' ou primeira frase demorando). */
    modelLoading: false,
    /** Modelos que já falaram nesta visita (então estão carregados no servidor). */
    loadedModels: new Set(),
  },
  /** Idioma detectado pela sessão ('pt', 'en'...) ou null. */
  detectedLang: null,
  /** @type {ReadingSession | null} uma por documento */
  session: null,
  /** Desliga os ouvintes da sessão do documento anterior. */
  docAbort: null,
  /** Aumenta a cada abertura; descarta resultados de aberturas antigas. */
  openToken: 0,
  /** Onde a leitura deve continuar: { pageNumber, sentenceIndex } | null */
  resumePos: null,
  /** true se as primeiras páginas não têm texto (PDF escaneado). */
  looksScanned: false,
  noVoicesWarned: false,
  testing: false,
};

const toaster = new Toaster(els.toastRegion);

// ---------- Módulo PDF (carregado sob demanda: depende do CDN) ----------
let pdfModulesPromise = null;

/** Carrega openPdf e PdfViewer. Se falhar (sem internet), tenta de novo na próxima vez. */
function loadPdfModules() {
  if (!pdfModulesPromise) {
    pdfModulesPromise = Promise.all([import('./pdf/pdf-document.js'), import('./pdf/pdf-viewer.js')])
      .then(([documentModule, viewerModule]) => ({
        openPdf: documentModule.openPdf,
        PdfViewer: viewerModule.PdfViewer,
      }))
      .catch((err) => {
        pdfModulesPromise = null;
        throw err;
      });
  }
  return pdfModulesPromise;
}

const PDF_LOAD_ERROR =
  'Não foi possível carregar o leitor de PDF. Na primeira vez é preciso estar conectado à internet; verifique a conexão e tente de novo.';

// ---------- Componentes de interface ----------
const toolbar = new Toolbar({
  elements: {
    openButton: els.openButton,
    title: byId('doc-title'),
    pageInput: byId('page-input'),
    pageTotal: byId('page-total'),
    zoomOut: byId('btn-zoom-out'),
    zoomIn: byId('btn-zoom-in'),
    zoomFit: byId('btn-zoom-fit'),
    zoomLabel: byId('zoom-label'),
    themeButton: byId('btn-theme'),
    settingsButton: byId('btn-settings'),
  },
  onGoToPage: goToPage,
  onZoomIn: () => state.doc && state.viewer?.zoomIn(),
  onZoomOut: () => state.doc && state.viewer?.zoomOut(),
  onZoomFit: () => state.doc && state.viewer?.setZoom('fit-width'),
  onToggleTheme: toggleTheme,
  onOpenSettings: () => settings.toggle(),
});

const player = new PlayerBar({
  elements: {
    root: byId('player-bar'),
    playButton: byId('btn-play'),
    stopButton: byId('btn-stop'),
    prevButton: byId('btn-prev'),
    nextButton: byId('btn-next'),
    caption: byId('player-caption'),
    progressBar: byId('player-progress'),
    progressFill: byId('player-progress-fill'),
    progressLabel: byId('player-progress-label'),
    status: byId('player-status'),
    statusText: byId('player-status-text'),
    langBadge: byId('player-lang'),
  },
  onToggle: togglePlay,
  onStop: stopReading,
  onPrevious: () => skip('previous'),
  onNext: () => skip('next'),
});

const settings = new SettingsPanel({
  elements: {
    panel: byId('settings-panel'),
    backdrop: byId('settings-backdrop'),
    closeButton: byId('btn-settings-close'),
    voiceSelect: byId('voice-select'),
    voiceHint: byId('voice-hint'),
    rateInput: byId('rate-input'),
    rateValue: byId('rate-value'),
    pitchField: byId('pitch-field'),
    pitchInput: byId('pitch-input'),
    pitchValue: byId('pitch-value'),
    volumeInput: byId('volume-input'),
    volumeValue: byId('volume-value'),
    testButton: byId('btn-test-voice'),
    resetButton: byId('btn-settings-reset'),
    unavailableNote: byId('settings-unavailable'),
    engineNeural: byId('engine-neural'),
    engineBrowser: byId('engine-browser'),
    neuralStatus: byId('neural-status'),
    neuralStatusText: byId('neural-status-text'),
    neuralStatusDetail: byId('neural-status-detail'),
    neuralStatusHint: byId('neural-status-hint'),
    neuralRetryButton: byId('btn-neural-retry'),
    modelField: byId('neural-model-field'),
    modelSelect: byId('neural-model-select'),
    languageSelect: byId('lang-select'),
    languageDetected: byId('lang-detected'),
  },
  onVoiceChange,
  onRateChange: (rate) => applyVoiceSetting('rate', rate),
  onPitchChange: (pitch) => applyVoiceSetting('pitch', pitch),
  onVolumeChange: (volume) => applyVoiceSetting('volume', volume),
  onTest: testVoice,
  onReset: () => {
    const { rate, pitch, volume } = DEFAULT_VOICE_SETTINGS;
    settings.setValues({ rate, pitch, volume });
    const engine = state.engine;
    if (engine) {
      engine.rate = rate;
      if (supportsPitch(engine)) engine.pitch = pitch;
      engine.volume = volume;
    }
    saveVoiceSettings({ rate, pitch, volume });
    restartIfPlaying();
  },
  onEngineChange: chooseEngine,
  onModelChange: chooseNeuralModel,
  onLanguageChange: chooseLanguage,
  onRetryServer: retryServer,
  onOpenChange: (open) => {
    toolbar.setSettingsExpanded(open);
    // Ao abrir, atualiza o estado do servidor (ex.: modelo carregado, servidor ligado agora).
    if (open && !state.neural.checking && Date.now() - state.neural.checkedAt > NEURAL_RECHECK_AFTER) {
      checkNeural({ silent: true }).catch(() => {});
    }
  },
});

setupFileDrop({
  fileInput: els.fileInput,
  openButtons: [els.openButton, els.welcomeOpenButton],
  overlay: els.dropOverlay,
  onFile: (file) => openFile(file),
  onReject: (file) => {
    const name = file?.name ? `“${file.name}” não é um PDF.` : 'Esse arquivo não é um PDF.';
    toaster.show(`${name} Escolha um arquivo com a extensão .pdf.`, { type: 'warning' });
  },
});

// ---------- Tema ----------
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

function effectiveTheme() {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'dark' || chosen === 'light') return chosen;
  return darkQuery?.matches ? 'dark' : 'light';
}

/** @param {'light' | 'dark' | null} theme null = seguir o sistema */
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  toolbar.setTheme(effectiveTheme());
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  saveTheme(next);
  applyTheme(next);
}

darkQuery?.addEventListener?.('change', () => toolbar.setTheme(effectiveTheme()));

// ---------- Motores de voz: utilitários ----------
/** @returns {'neural' | 'browser' | null} */
function engineKind(engine) {
  if (!engine) return null;
  if (engine.kind === 'neural' || engine.kind === 'browser') return engine.kind;
  return engine === state.engines.neural ? 'neural' : 'browser';
}

function supportsPitch(engine) {
  if (!engine) return true;
  return typeof engine.supportsPitch === 'boolean' ? engine.supportsPitch : engineKind(engine) === 'browser';
}

/** Idiomas de uma voz (o da IA pode ter vários em `languages`). */
function voiceLanguages(voice) {
  if (!voice) return [];
  const list = Array.isArray(voice.languages) && voice.languages.length ? voice.languages : [voice.lang];
  return list.filter(Boolean).map((l) => baseLanguage(l));
}

/** Motor neural a que a voz pertence: campo `engine` ou prefixo do id ("kokoro:pf_dora"). */
function voiceModelOf(voice) {
  if (voice?.engine) return String(voice.engine);
  const id = String(voice?.id ?? '');
  return id.includes(':') ? id.split(':')[0] : null;
}

/** Motores neurais disponíveis no servidor ({ id, name, languages, loaded }). */
function neuralModels() {
  const engines = state.neural.status?.engines;
  return Array.isArray(engines) ? engines.filter((e) => e && e.available && e.id) : [];
}

/** Motor neural escolhido: o salvo, ou o padrão do servidor, ou o primeiro disponível. */
function currentModelId() {
  const models = neuralModels();
  if (!models.length) return null;
  const saved = loadEngineSettings().neuralModel;
  if (saved && models.some((m) => m.id === saved)) return saved;
  const fallback = state.neural.status?.defaultEngine;
  if (fallback && models.some((m) => m.id === fallback)) return fallback;
  return models[0].id;
}

function isModelLoaded(modelId = currentModelId()) {
  if (!modelId) return false;
  if (state.neural.loadedModels.has(modelId)) return true;
  return Boolean(neuralModels().find((m) => m.id === modelId)?.loaded);
}

/** Vozes da IA do motor neural escolhido (se o servidor tiver mais de um). */
function neuralVoicesFor(engine, modelId) {
  const all = engine?.getVoices?.() ?? [];
  if (neuralModels().length < 2 || !modelId) return all;
  const filtered = all.filter((v) => {
    const model = voiceModelOf(v);
    return !model || model === modelId;
  });
  return filtered.length ? filtered : all;
}

/** Voz recomendada: a padrão que fala português, depois qualquer padrão, depois a primeira. */
function defaultNeuralVoice(voices) {
  const isDefault = (v) => Boolean(v.isDefault || v.default);
  const speaksPt = (v) => voiceLanguages(v).includes('pt');
  return (
    voices.find((v) => isDefault(v) && speaksPt(v)) ??
    voices.find(isDefault) ??
    voices.find(speaksPt) ??
    voices[0] ??
    null
  );
}

/** Ajusta o NeuralSpeechEngine para o motor neural escolhido e uma voz dele. */
function applyNeuralModel(engine, modelId) {
  if (!engine || !modelId) return;
  // O contrato não fixa como o motor neural é escolhido: usa o que o engine oferecer.
  try {
    if (typeof engine.setEngine === 'function') engine.setEngine(modelId);
    else if ('engineId' in engine) engine.engineId = modelId;
  } catch (err) {
    console.warn('Não foi possível escolher o modelo da voz de IA:', err);
  }

  const voices = neuralVoicesFor(engine, modelId);
  if (!voices.length) return;
  const saved = loadEngineSettings().neuralVoiceId;
  const savedVoice = saved ? voices.find((v) => v.id === saved) : null;
  if (savedVoice) {
    engine.setVoice(savedVoice.id);
  } else if (!voices.some((v) => v.id === engine.voiceId)) {
    const pick = defaultNeuralVoice(voices);
    if (pick) engine.setVoice(pick.id);
  }
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Voz de IA: conferir o servidor ----------
let neuralModulePromise = null;

/** Carrega neural-engine.js sob demanda (se faltar, o site continua com a voz do navegador). */
function loadNeuralModule() {
  if (!neuralModulePromise) {
    neuralModulePromise = import('./tts/neural-engine.js').catch((err) => {
      neuralModulePromise = null;
      throw err;
    });
  }
  return neuralModulePromise;
}

/** Pergunta ao servidor (GET /api/tts/status) se a voz de IA está disponível. */
async function probeNeural() {
  let Ctor = null;
  try {
    Ctor = (await loadNeuralModule()).NeuralSpeechEngine ?? null;
  } catch (err) {
    console.warn('Falha ao carregar a voz de IA:', err);
  }
  if (typeof Ctor !== 'function') {
    return { Ctor: null, status: null, reason: 'a parte do site que fala com a voz de IA não foi encontrada.' };
  }
  if (typeof Ctor.isSupported === 'function' && !Ctor.isSupported()) {
    return { Ctor: null, status: null, reason: 'este navegador não consegue tocar o áudio da voz de IA.' };
  }

  let status = null;
  try {
    status = typeof Ctor.probe === 'function' ? await withTimeout(Promise.resolve(Ctor.probe('')), NEURAL_PROBE_TIMEOUT) : null;
  } catch {
    status = null;
  }
  if (!status || typeof status !== 'object' || status.ok === false) {
    return { Ctor, status: null, reason: 'o servidor de voz não respondeu (ele está desligado ou a página foi aberta por outro servidor).' };
  }

  const engines = Array.isArray(status.engines) ? status.engines : [];
  if (!engines.some((e) => e && e.available)) {
    const error = engines.map((e) => e?.error).find((m) => typeof m === 'string' && m.trim());
    return { Ctor, status, reason: error ? lowerFirst(error) : 'nenhum modelo de voz está instalado no servidor.' };
  }
  return { Ctor, status, reason: '' };
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Atualiza state.neural com a resposta do servidor e redesenha os ajustes.
 * @param {{ silent?: boolean }} [options] silent = não mostra "Verificando…" (conferência de fundo)
 */
async function checkNeural({ silent = false } = {}) {
  state.neural.checking = true;
  if (!silent) renderNeuralStatus();
  let result;
  try {
    result = await probeNeural();
  } finally {
    state.neural.checking = false;
  }
  const n = state.neural;
  if (result.Ctor) n.Ctor = result.Ctor;
  n.status = result.status;
  n.available = !result.reason;
  n.reason = result.reason;
  n.checkedAt = Date.now();
  refreshEngineUI();
  return n.available;
}

function deviceText() {
  const status = state.neural.status;
  if (!status) return '';
  if (status.device === 'cuda') return `Usando a placa de vídeo: ${status.gpu || 'NVIDIA'}.`;
  return 'Usando o processador (CPU): funciona, mas gera a voz mais devagar que uma placa de vídeo.';
}

function renderNeuralStatus() {
  const n = state.neural;
  if (n.checking) {
    settings.setNeuralStatus({ state: 'checking', message: 'Verificando a voz de IA…' });
    return;
  }
  if (!n.available) {
    settings.setNeuralStatus({
      state: 'unavailable',
      message: 'Voz de IA indisponível',
      detail: upperFirst(n.reason || 'o servidor de voz não respondeu.'),
      showHint: true,
    });
    return;
  }
  const models = neuralModels();
  const model = models.find((m) => m.id === currentModelId());
  const modelName = models.length > 1 && model?.name ? ` · ${model.name}` : '';
  if (n.modelLoading) {
    settings.setNeuralStatus({
      state: 'loading',
      message: `Carregando o modelo de voz…${modelName}`,
      detail: `Na primeira vez pode levar de 10 a 30 segundos. ${deviceText()}`.trim(),
    });
    return;
  }
  settings.setNeuralStatus({
    state: 'ready',
    message: isModelLoaded() ? `Pronta${modelName}` : `Pronta${modelName} (o modelo carrega na primeira leitura)`,
    detail: deviceText(),
  });
}

/** Idiomas que podem ser fixados com o motor atual. */
function readingLanguages() {
  if (engineKind(state.engine) === 'neural') {
    const model = neuralModels().find((m) => m.id === currentModelId());
    if (Array.isArray(model?.languages) && model.languages.length) return model.languages;
  }
  return [...BROWSER_READING_LANGUAGES];
}

/** Redesenha tudo o que depende do motor: escolha, estado, modelos, vozes, tom, idiomas. */
function refreshEngineUI() {
  const kind = engineKind(state.engine);
  settings.setEngineChoice(kind, {
    neuralAvailable: state.neural.available,
    browserAvailable: state.browserSupported,
  });
  renderNeuralStatus();
  settings.setNeuralModels(
    neuralModels().map((m) => ({ id: m.id, name: m.name || m.id })),
    currentModelId(),
    { visible: kind === 'neural' },
  );
  settings.setPitchVisible(supportsPitch(state.engine));
  settings.setLanguages(readingLanguages(), loadEngineSettings().language);
  settings.setDetectedLanguage(state.detectedLang);
  refreshVoices(false);
}

// ---------- Motores de voz: criar e trocar ----------
function getBrowserEngine() {
  if (!state.browserSupported) return Promise.resolve(null);
  if (!state.enginePromises.browser) {
    state.enginePromises.browser = (async () => {
      const engine = new SpeechEngine();
      state.engines.browser = engine;
      // Algumas vozes (ex.: as "Online" do Edge) chegam depois; atualiza a lista.
      engine.addEventListener('voiceschanged', () => {
        if (state.engine === engine) refreshVoices(false);
      });
      try {
        await engine.init({ preferredVoiceId: loadVoiceSettings().voiceId });
      } catch (err) {
        console.warn('Falha ao carregar as vozes:', err);
      }
      return engine;
    })();
  }
  return state.enginePromises.browser;
}

function getNeuralEngine() {
  const Ctor = state.neural.Ctor;
  if (!state.neural.available || typeof Ctor !== 'function') return Promise.resolve(null);
  if (!state.enginePromises.neural) {
    state.enginePromises.neural = (async () => {
      const engine = new Ctor({ baseUrl: '' });
      engine.addEventListener('voiceschanged', () => {
        if (state.engine === engine) refreshVoices(false);
      });
      await engine.init?.({ preferredVoiceId: loadEngineSettings().neuralVoiceId });
      state.engines.neural = engine;
      return engine;
    })().catch((err) => {
      state.enginePromises.neural = null;
      throw err;
    });
  }
  return state.enginePromises.neural;
}

/** Aplica os ajustes salvos (velocidade, tom, volume, voz) ao motor que vai entrar. */
function applySavedSettings(engine) {
  const saved = loadVoiceSettings();
  engine.rate = saved.rate;
  engine.volume = saved.volume;
  if (supportsPitch(engine)) engine.pitch = saved.pitch;
  if (engineKind(engine) === 'neural') applyNeuralModel(engine, currentModelId());
}

/** Idiomas que a voz de IA não fala e já foram avisados (um aviso por idioma). */
const warnedFallbacks = new Set();

/** Ouve os eventos opcionais do motor atual ('loadingmodel', 'langfallback'). */
function wireEngine(engine) {
  state.engineAbort?.abort();
  const controller = new AbortController();
  state.engineAbort = controller;
  const opts = { signal: controller.signal };
  engine.addEventListener('loadingmodel', (event) => onLoadingModel(event), opts);
  engine.addEventListener(
    'langfallback',
    (event) => {
      const { requested, used } = event.detail ?? {};
      if (!requested || warnedFallbacks.has(requested)) return;
      warnedFallbacks.add(requested);
      const usedText = used ? ` Lendo com a voz em ${languageName(used).toLowerCase()}.` : '';
      toaster.show(
        `A voz de IA não fala ${languageName(requested).toLowerCase()}.${usedText} Para esse idioma, a voz do navegador pode soar melhor.`,
        { type: 'warning' },
      );
    },
    opts,
  );
}

/**
 * Passa a usar o motor pedido. Se estava lendo, recria a sessão e continua da mesma frase.
 * @param {'neural' | 'browser'} kind
 * @returns {Promise<boolean>} false se o motor não está disponível
 */
async function useEngine(kind) {
  const token = ++state.engineToken;
  let engine = null;
  try {
    engine = kind === 'neural' ? await getNeuralEngine() : await getBrowserEngine();
  } catch (err) {
    console.warn(`Falha ao preparar a voz (${kind}):`, err);
    engine = null;
  }
  if (token !== state.engineToken) return false;
  if (!engine) return false;
  if (engine === state.engine) {
    refreshEngineUI();
    return true;
  }

  // Guarda onde estava e se estava tocando, para continuar com o motor novo.
  const session = state.session;
  const wasActive = Boolean(session && (session.state === 'playing' || session.state === 'loading'));
  const pos = session?.position ?? null;
  if (session) destroySession();
  try {
    state.engine?.cancel();
  } catch {
    // Nada sendo falado.
  }
  hideVoiceLoading();

  state.engine = engine;
  applySavedSettings(engine);
  wireEngine(engine);
  player.setAvailable(true);
  settings.setEnabled(true);
  refreshEngineUI();

  if (state.doc) {
    if (pos) state.resumePos = pos;
    if (session && !wasActive) {
      // Estava pausado: os ouvintes da sessão antiga já foram soltos, então volta o player
      // ao estado parado aqui. O próximo ▶ continua da mesma frase.
      onSessionState('idle');
    }
    createSession(state.doc);
    if (wasActive) startReading(state.resumePos);
  }
  return true;
}

// ---------- Voz: partida ----------
async function setupSpeech() {
  state.browserSupported = SpeechEngine.isSupported();
  const prefs = loadEngineSettings();
  settings.setValues(loadVoiceSettings());
  refreshEngineUI();

  const neuralCheck = checkNeural().catch((err) => {
    console.warn('Falha ao conferir a voz de IA:', err);
    return false;
  });

  let ok = false;
  if (prefs.engine === 'browser' && state.browserSupported) {
    // O usuário prefere a voz do navegador: não espera o servidor para começar.
    ok = await useEngine('browser');
    await neuralCheck;
    refreshEngineUI();
  } else {
    const neuralOk = await neuralCheck;
    if (neuralOk) {
      ok = await useEngine('neural');
      if (!ok) {
        state.neural.available = false;
        state.neural.reason = 'não foi possível preparar a voz de IA.';
      }
    }
    if (!ok && state.browserSupported) {
      ok = await useEngine('browser');
      if (ok) {
        // Aviso discreto: a leitura funciona com a voz do navegador.
        // Servidor respondeu mas sem modelo: mostra o motivo; servidor desligado: diz como ligar.
        const notice = state.neural.status
          ? `A voz de IA não está disponível: ${state.neural.reason} Por enquanto a leitura usa a voz do navegador.`
          : `A voz de IA não está ligada; por enquanto a leitura usa a voz do navegador. ${START_SERVER_TIP}`;
        toaster.show(notice, {
          type: 'info',
          duration: 10000,
          action: { label: 'Ajustes', onClick: () => settings.open() },
        });
      }
    }
  }

  state.speechReady = true;
  if (!ok) {
    setNoEngine();
    return;
  }
  refreshVoices(true);
  // Se já houver um PDF aberto (o usuário foi rápido), cria a sessão agora.
  if (state.doc && !state.session) createSession(state.doc);
}

/** Nenhuma voz disponível: o PDF continua visível, mas não dá para ouvir. */
function setNoEngine() {
  const message = state.browserSupported
    ? 'Não foi possível preparar a voz. Recarregue a página para tentar de novo.'
    : `Este navegador não tem voz sintética e a voz de IA não está ligada. Dá para ver o PDF, mas não ouvir. ${START_SERVER_TIP} Ou use o Edge ou o Chrome.`;
  player.setAvailable(false, message);
  settings.setEnabled(false, message);
  settings.setVoices([], null);
  refreshEngineUI();
  toaster.show(message, { type: 'warning', duration: 12000 });
}

// ---------- Voz: escolhas nos ajustes ----------
/** @param {'neural' | 'browser'} kind */
function chooseEngine(kind) {
  // Dentro do toque: libera o áudio no iOS/Safari se o motor já existe.
  state.engines[kind]?.unlock?.();
  saveEngineSettings({ engine: kind });
  useEngine(kind).then((ok) => {
    if (ok) {
      if (kind === 'neural' && !isModelLoaded()) {
        toaster.show('Voz de IA escolhida. A primeira frase pode demorar até 30 segundos enquanto o modelo carrega.');
      }
      return;
    }
    const message =
      kind === 'neural'
        ? `Não foi possível usar a voz de IA: ${state.neural.reason || 'o servidor de voz não respondeu.'}`
        : 'A voz do navegador não está disponível neste navegador.';
    toaster.show(message, { type: 'error' });
    refreshEngineUI();
  });
}

/** @param {string} modelId motor neural (ex.: 'kokoro') */
function chooseNeuralModel(modelId) {
  if (!neuralModels().some((m) => m.id === modelId)) return;
  saveEngineSettings({ neuralModel: modelId });
  const engine = state.engine;
  if (engineKind(engine) === 'neural') {
    applyNeuralModel(engine, modelId);
    state.neural.modelLoading = false;
    hideVoiceLoading();
    restartIfPlaying();
  }
  refreshEngineUI();
}

/** @param {string} lang 'auto' ou código do idioma */
function chooseLanguage(lang) {
  saveEngineSettings({ language: lang });
  state.session?.setLanguage?.(lang);
  renderLanguageBadge();
  restartIfPlaying();
}

async function retryServer() {
  settings.setRetrying();
  const available = await checkNeural().catch(() => false);
  if (!available) {
    toaster.show(`A voz de IA ainda não respondeu. ${START_SERVER_TIP}`, { type: 'warning' });
    return;
  }
  // Servidor ligado agora: passa para a voz de IA, a menos que o usuário prefira a do navegador.
  if (engineKind(state.engine) !== 'neural' && loadEngineSettings().engine !== 'browser') {
    const ok = await useEngine('neural');
    if (ok) {
      state.speechReady = true;
      if (state.doc && !state.session) createSession(state.doc);
      toaster.show('Voz de IA ligada.', { type: 'success' });
      return;
    }
  }
  toaster.show('A voz de IA está disponível.', { type: 'success' });
}

function onVoiceChange(voiceId) {
  const engine = state.engine;
  if (!engine) return;
  engine.setVoice(voiceId);
  if (engineKind(engine) === 'neural') saveEngineSettings({ neuralVoiceId: voiceId });
  else saveVoiceSettings({ voiceId });
  restartIfPlaying();
}

/** @param {boolean} warnIfEmpty */
function refreshVoices(warnIfEmpty) {
  const engine = state.engine;
  if (!engine) return;

  if (engineKind(engine) === 'neural') {
    settings.setVoices(neuralVoicesFor(engine, currentModelId()), engine.voiceId ?? null, 'neural');
    return;
  }

  const voices = engine.getVoices();
  const wanted = loadVoiceSettings().voiceId;
  if (wanted && engine.voiceId !== wanted && voices.some((v) => v.id === wanted)) {
    engine.setVoice(wanted);
  }
  settings.setVoices(voices, engine.voiceId, 'browser');

  if (!voices.length && warnIfEmpty && !state.noVoicesWarned) {
    state.noVoicesWarned = true;
    toaster.show(
      'Nenhuma voz foi encontrada. No Windows, instale uma voz em português em Configurações > Hora e idioma > Fala.',
      { type: 'warning', duration: 12000 },
    );
  }
}

function applyVoiceSetting(key, value) {
  const engine = state.engine;
  if (engine && (key !== 'pitch' || supportsPitch(engine))) engine[key] = value;
  saveVoiceSettings({ [key]: value });
  restartIfPlaying();
}

/** Ajustes de voz valem a partir da frase atual (pausado: ao continuar, a frase recomeça). */
function restartIfPlaying() {
  const session = state.session;
  if (session && ACTIVE_STATES.includes(session.state)) session.restartCurrent();
}

/** Idioma da frase de teste: o fixado, o detectado, o da voz escolhida ou português. */
function testLanguage(engine) {
  const fixed = loadEngineSettings().language;
  if (fixed !== 'auto') return fixed;
  if (state.detectedLang) return state.detectedLang;
  const voices = engine.getVoices?.() ?? [];
  const langs = voiceLanguages(voices.find((v) => v.id === engine.voiceId));
  if (langs.length === 1 && langs[0]) return langs[0];
  return langs.includes('pt') || !langs.length ? 'pt' : langs[0];
}

async function testVoice() {
  const engine = state.engine;
  if (!engine || state.testing) return;
  engine.unlock?.();

  // A frase de teste não pode competir com a leitura: para e guarda a posição.
  const session = state.session;
  if (session && ACTIVE_STATES.includes(session.state)) {
    const pos = session.position;
    session.stop();
    if (pos) state.resumePos = pos;
    clearHighlight();
  }

  let lang = testLanguage(engine);
  if (!TEST_PHRASES[lang]) lang = 'en';
  const neural = engineKind(engine) === 'neural';
  const cold = neural && !isModelLoaded();

  state.testing = true;
  settings.setTesting(true);
  if (cold) {
    state.neural.modelLoading = true;
    renderNeuralStatus();
  }
  try {
    const result = await engine.speak(TEST_PHRASES[lang], { id: 'teste-de-voz', lang });
    if (neural && result !== 'cancelled') markModelLoaded();
  } catch (err) {
    toaster.show(err?.message || 'Não foi possível testar a voz.', { type: 'error' });
  } finally {
    state.testing = false;
    settings.setTesting(false);
    // Some com o aviso de carregamento (inclusive o vindo do evento 'loadingmodel').
    hideVoiceLoading();
  }
}

// ---------- Aviso "Carregando voz de IA…" ----------
/** fromEvent = o aviso veio do evento 'loadingmodel' (só some quando ele terminar ou a voz sair). */
const voiceWait = { timer: null, visible: false, fromEvent: false };

/** Começou uma frase: se a voz de IA demorar a sair, mostra o aviso na barra do player. */
function scheduleVoiceLoading() {
  clearTimeout(voiceWait.timer);
  voiceWait.timer = null;
  if (engineKind(state.engine) !== 'neural') return;
  const cold = !isModelLoaded();
  voiceWait.timer = setTimeout(() => showVoiceLoading(cold), cold ? VOICE_WAIT_COLD : VOICE_WAIT_WARM);
}

/** @param {boolean} cold true = o modelo ainda não carregou */
function showVoiceLoading(cold) {
  voiceWait.timer = null;
  const session = state.session;
  if (!session || !(session.state === 'playing' || session.state === 'loading')) return;
  voiceWait.visible = true;
  voiceWait.fromEvent = false;
  player.setVoiceLoading(
    true,
    cold ? 'Carregando voz de IA… na primeira vez pode levar até 30 segundos.' : 'Gerando a voz de IA…',
  );
  if (cold && !state.neural.modelLoading) {
    state.neural.modelLoading = true;
    renderNeuralStatus();
  }
}

function hideVoiceLoading() {
  clearTimeout(voiceWait.timer);
  voiceWait.timer = null;
  if (voiceWait.visible) {
    voiceWait.visible = false;
    voiceWait.fromEvent = false;
    player.setVoiceLoading(false);
  }
  if (state.neural.modelLoading && !state.testing) {
    state.neural.modelLoading = false;
    renderNeuralStatus();
  }
}

/** A voz começou a sair: o modelo está carregado. */
function onVoiceStarted() {
  const wasLoading = state.neural.modelLoading;
  hideVoiceLoading();
  if (engineKind(state.engine) === 'neural' && (wasLoading || !isModelLoaded())) markModelLoaded();
}

function markModelLoaded() {
  const id = currentModelId();
  if (id) state.neural.loadedModels.add(id);
  state.neural.modelLoading = false;
  renderNeuralStatus();
}

/** Evento opcional 'loadingmodel' (sessão ou motor). detail.loading === false = terminou. */
function onLoadingModel(event) {
  if (event?.detail?.loading === false) {
    onVoiceStarted();
    return;
  }
  clearTimeout(voiceWait.timer);
  voiceWait.timer = null;
  voiceWait.visible = true;
  voiceWait.fromEvent = true;
  player.setVoiceLoading(true, 'Carregando voz de IA… na primeira vez pode levar até 30 segundos.');
  state.neural.modelLoading = true;
  renderNeuralStatus();
}

// ---------- Idioma da leitura ----------
function onLanguageDetected(lang) {
  state.detectedLang = lang ? baseLanguage(lang) : null;
  settings.setDetectedLanguage(state.detectedLang);
  renderLanguageBadge();
}

/** Selo do idioma no player: o fixado nos ajustes ou o detectado. */
function renderLanguageBadge() {
  if (!state.doc) {
    player.setLanguage(null);
    return;
  }
  const fixed = loadEngineSettings().language;
  if (fixed !== 'auto') player.setLanguage(fixed, { fixed: true });
  else player.setLanguage(state.detectedLang);
}

// ---------- Abrir e fechar documentos ----------
/** @param {File} file */
async function openFile(file) {
  if (!isPdfFile(file)) return;
  const token = ++state.openToken;

  if (els.passwordDialog.open) els.passwordDialog.close('cancel');
  settings.close();
  closeDocument();
  toolbar.setLoading(file.name);

  let modules;
  try {
    modules = await loadPdfModules();
  } catch (err) {
    console.warn('Falha ao carregar o pdf.js:', err);
    if (token !== state.openToken) return;
    toaster.show(PDF_LOAD_ERROR, { type: 'error', duration: 12000 });
    showWelcome();
    return;
  }
  if (token !== state.openToken) return;

  let doc = null;
  let password;
  while (!doc) {
    try {
      doc = await modules.openPdf(file, password === undefined ? {} : { password });
    } catch (err) {
      if (token !== state.openToken) return;
      const code = err?.code;
      if (code === 'PASSWORD_REQUIRED' || code === 'PASSWORD_INCORRECT') {
        const message =
          password !== undefined
            ? 'Senha incorreta. Confira e tente de novo.'
            : 'Este PDF é protegido. Digite a senha para abrir.';
        password = await askPassword(message, file.name);
        if (token !== state.openToken) return;
        if (password === null) {
          toaster.show('O PDF não foi aberto porque a senha não foi informada.');
          showWelcome();
          return;
        }
        continue;
      }
      toaster.show(
        code === 'INVALID_PDF'
          ? `Não foi possível abrir “${file.name}”: o arquivo parece estar corrompido ou não é um PDF de verdade.`
          : `Não foi possível abrir “${file.name}”.`,
        { type: 'error' },
      );
      if (code !== 'INVALID_PDF') console.warn('Erro ao abrir o PDF:', err);
      showWelcome();
      return;
    }
  }

  if (token !== state.openToken) {
    Promise.resolve(doc.destroy()).catch(() => {});
    return;
  }
  await showDocument(doc, modules, token);
}

async function showDocument(doc, modules, token) {
  state.doc = doc;
  els.welcome.hidden = true;
  // O contêiner precisa estar visível antes de open() para medir a largura.
  els.viewer.hidden = false;

  if (!state.viewer) {
    state.viewer = new modules.PdfViewer(els.viewer);
    wireViewer(state.viewer);
  }

  try {
    await state.viewer.open(doc);
  } catch (err) {
    if (token !== state.openToken) return;
    console.warn('Erro ao mostrar o PDF:', err);
    toaster.show('Não foi possível mostrar as páginas deste PDF.', { type: 'error' });
    closeDocument();
    showWelcome();
    return;
  }
  if (token !== state.openToken) return;

  toolbar.setDocument({ title: doc.title, numPages: doc.numPages });
  toolbar.setZoom(state.viewer.zoom);
  document.title = `${doc.title} · ${APP_NAME}`;
  player.setDocumentLoaded(true);
  player.setProgress({ pageNumber: 1, numPages: doc.numPages, fraction: 0 });
  renderLanguageBadge();

  if (state.engine) createSession(doc);
  updateMediaMetadata(1);
  restorePosition(doc);
  checkScanned(doc, token);
  els.viewer.focus({ preventScroll: true });
}

/** Para a sessão atual e solta os ouvintes dela. */
function destroySession() {
  if (!state.session) return;
  state.docAbort?.abort();
  try {
    if (typeof state.session.destroy === 'function') state.session.destroy();
    else state.session.stop();
  } catch {
    // A sessão já estava parada.
  }
  state.session = null;
  state.docAbort = null;
}

/** Para a leitura e fecha o documento atual (se houver). */
function closeDocument() {
  savePositionSoon.flush();

  destroySession();
  try {
    state.engine?.cancel();
  } catch {
    // Nada sendo falado.
  }
  hideVoiceLoading();

  state.viewer?.close();
  if (state.doc) {
    const old = state.doc;
    state.doc = null;
    Promise.resolve(old.destroy()).catch(() => {});
  }

  state.resumePos = null;
  state.looksScanned = false;
  state.detectedLang = null;
  settings.setDetectedLanguage(null);
  toolbar.setDocument(null);
  player.reset();
  player.setDocumentLoaded(false);
  document.title = APP_NAME;
  updateMediaMetadata(null);
}

function showWelcome() {
  toolbar.setDocument(null);
  els.viewer.hidden = true;
  els.welcome.hidden = false;
}

/**
 * Pede a senha do PDF. Devolve a senha ou null se o usuário cancelar.
 * @param {string} message
 * @param {string} fileName
 * @returns {Promise<string | null>}
 */
function askPassword(message, fileName) {
  const dialog = els.passwordDialog;
  if (typeof dialog.showModal !== 'function') {
    // Navegador muito antigo, sem <dialog>.
    return Promise.resolve(window.prompt(message));
  }
  return new Promise((resolve) => {
    els.passwordMessage.textContent = message;
    els.passwordFile.textContent = fileName ? `Arquivo: ${fileName}` : '';
    els.passwordInput.value = '';
    dialog.returnValue = '';

    const onCancelClick = () => dialog.close('cancel');
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      els.passwordCancel.removeEventListener('click', onCancelClick);
      const value = els.passwordInput.value;
      els.passwordInput.value = '';
      resolve(dialog.returnValue === 'ok' && value ? value : null);
    };
    dialog.addEventListener('close', onClose);
    els.passwordCancel.addEventListener('click', onCancelClick);
    dialog.showModal();
    els.passwordInput.focus();
  });
}

/** Vai para a posição salva deste PDF e avisa, com opção de começar do início. */
function restorePosition(doc) {
  const saved = loadPosition(doc.fingerprint);
  if (!saved || saved.pageNumber > doc.numPages) return;
  if (saved.pageNumber === 1 && saved.sentenceIndex === 0) return;

  state.resumePos = { pageNumber: saved.pageNumber, sentenceIndex: saved.sentenceIndex };
  state.viewer.goToPage(saved.pageNumber, { behavior: 'auto' });
  toolbar.setPage(saved.pageNumber);
  player.setProgress({ pageNumber: saved.pageNumber, numPages: doc.numPages, fraction: 0 });

  toaster.show(`Você parou na página ${saved.pageNumber}. Toque em ▶ para continuar de onde parou.`, {
    type: 'info',
    duration: 12000,
    action: {
      label: 'Começar do início',
      onClick: () => {
        if (state.doc !== doc) return;
        state.resumePos = null;
        clearPosition(doc.fingerprint);
        state.viewer.goToPage(1);
        if (state.session && ACTIVE_STATES.includes(state.session.state)) {
          startReading({ pageNumber: 1, sentenceIndex: 0 });
        }
      },
    },
  });
}

/** Se as primeiras páginas não têm texto, o PDF provavelmente é escaneado (só imagens). */
async function checkScanned(doc, token) {
  const count = Math.min(SCAN_CHECK_PAGES, doc.numPages);
  try {
    const pages = await Promise.all(Array.from({ length: count }, (_, i) => doc.getPageText(i + 1)));
    if (token !== state.openToken) return;
    if (pages.length && pages.every((page) => page.isEmpty)) {
      state.looksScanned = true;
      warnScanned();
    }
  } catch (err) {
    console.warn('Não foi possível ler o texto das primeiras páginas:', err);
  }
}

function warnScanned() {
  toaster.show(
    'Este PDF parece ser digitalizado (só imagens): não há texto para ler em voz alta nas primeiras páginas. Você ainda pode ver as páginas.',
    { type: 'warning', duration: 12000 },
  );
}

/** Explica por que ainda não dá para ouvir (voz preparando ou nenhuma voz). */
function warnNoSession() {
  if (!state.speechReady) {
    toaster.show('A voz ainda está sendo preparada. Tente de novo em alguns segundos.');
  } else if (!state.engine) {
    toaster.show('Nenhuma voz está disponível, então não dá para ouvir o texto. Veja os ajustes de voz.', { type: 'warning' });
  }
}

// ---------- Visualizador ----------
function wireViewer(viewer) {
  viewer.addEventListener('pagechange', (event) => {
    if (!state.doc) return;
    toolbar.setPage(event.detail.pageNumber);
  });
  viewer.addEventListener('zoomchange', (event) => {
    if (!state.doc) return;
    toolbar.setZoom(event.detail.zoom);
  });
  viewer.addEventListener('sentenceclick', (event) => {
    const sentence = event.detail?.sentence;
    if (!state.doc || !sentence) return;
    if (!state.session) {
      warnNoSession();
      return;
    }
    startReading({ pageNumber: sentence.pageNumber, sentenceIndex: sentence.index });
  });
}

/** Ir para uma página digitada no cabeçalho. */
function goToPage(pageNumber) {
  if (!state.doc || !state.viewer) return;
  state.viewer.goToPage(pageNumber);
  // Fora da leitura, o próximo play começa na página escolhida.
  const reading = state.session && ACTIVE_STATES.includes(state.session.state);
  if (!reading) state.resumePos = null;
}

// ---------- Sessão de leitura ----------
function createSession(doc) {
  const engine = state.engine;
  if (!engine) return;

  const controller = new AbortController();
  const opts = { signal: controller.signal };
  const session = new ReadingSession({ engine, source: doc });
  state.session = session;
  state.docAbort = controller;
  session.setLanguage?.(loadEngineSettings().language);

  session.addEventListener('statechange', (event) => onSessionState(event.detail.state), opts);
  session.addEventListener('sentence', (event) => onSentence(event.detail.sentence), opts);
  session.addEventListener(
    'word',
    (event) => {
      if (voiceWait.timer || voiceWait.visible || state.neural.modelLoading) onVoiceStarted();
      const { sentence, charIndex, charLength } = event.detail;
      state.viewer?.highlightWord(sentence, charIndex, charLength);
    },
    opts,
  );
  session.addEventListener('pagechange', (event) => updateMediaMetadata(event.detail.pageNumber), opts);
  session.addEventListener('finished', () => onFinished(doc), opts);
  session.addEventListener('error', (event) => onSessionError(event.detail), opts);
  // Eventos opcionais da versão 2 (podem não existir).
  session.addEventListener('langchange', (event) => onLanguageDetected(event.detail?.lang ?? null), opts);
  session.addEventListener('loadingmodel', (event) => onLoadingModel(event), opts);
}

function onSessionError(detail) {
  hideVoiceLoading();
  const message = detail?.message || 'Houve um problema com a leitura em voz alta.';
  const engineProblem = engineKind(state.engine) === 'neural' && !NON_ENGINE_ERRORS.includes(detail?.code);
  if (engineProblem && state.browserSupported) {
    toaster.show(message, {
      type: 'error',
      action: {
        label: 'Usar voz do navegador',
        onClick: () => {
          state.engines.browser?.unlock?.();
          saveEngineSettings({ engine: 'browser' });
          useEngine('browser').then((ok) => {
            if (ok && state.doc) startReading(state.resumePos);
          });
        },
      },
    });
    return;
  }
  toaster.show(message, { type: 'error' });
}

function onSessionState(sessionState) {
  player.setState(sessionState);
  setMediaPlaybackState(sessionState);
  if (sessionState !== 'playing' && sessionState !== 'loading') hideVoiceLoading();
  if (sessionState === 'idle') {
    clearHighlight();
    player.showIdleHint();
  }
}

function onSentence(sentence) {
  const doc = state.doc;
  if (!doc) return;
  state.resumePos = { pageNumber: sentence.pageNumber, sentenceIndex: sentence.index };
  state.viewer?.highlightSentence(sentence);
  player.setCaption(sentence.text);
  savePositionSoon();

  // Voz de IA: se a nova frase demorar a sair, mostra o aviso na barra do player.
  // (Durante o carregamento do modelo avisado pelo evento 'loadingmodel', o aviso fica.)
  const session = state.session;
  if (session && (session.state === 'playing' || session.state === 'loading')) {
    if (voiceWait.visible && !voiceWait.fromEvent) {
      voiceWait.visible = false;
      player.setVoiceLoading(false);
    }
    if (!voiceWait.visible) scheduleVoiceLoading();
  }

  // Progresso dentro da página (getPageText usa cache, é rápido).
  doc
    .getPageText(sentence.pageNumber)
    .then((page) => {
      if (state.doc !== doc) return;
      const total = Math.max(1, page.sentences.length);
      player.setProgress({
        pageNumber: sentence.pageNumber,
        numPages: doc.numPages,
        fraction: (sentence.index + 1) / total,
      });
    })
    .catch(() => {});
}

function onFinished(doc) {
  if (state.doc !== doc) return;
  state.resumePos = null;
  savePositionSoon.cancel();
  clearPosition(doc.fingerprint);
  clearHighlight();
  player.setCaption('Fim do documento. Toque em ▶ para ler de novo.', { muted: true });
  toaster.show('Leitura concluída: você chegou ao fim do documento.', { type: 'success' });
}

function clearHighlight() {
  state.viewer?.highlightSentence(null, { scroll: false });
}

/** Começa a ler de uma posição; sem posição, continua de onde parou ou usa a página visível. */
function startReading(position) {
  // Precisa ser chamado dentro do toque/clique (iOS/Safari só libera a voz assim).
  state.engine?.unlock?.();
  const session = state.session;
  if (!session || !state.doc) {
    if (state.doc) warnNoSession();
    return;
  }
  if (state.looksScanned) warnScanned();

  let start = position;
  if (!start) {
    const visible = state.viewer?.currentPage || 1;
    const resume = state.resumePos;
    // Continua de onde parou se o usuário ainda está por perto daquela página;
    // se rolou para longe, começa no topo da página que está vendo.
    start = resume && Math.abs(resume.pageNumber - visible) <= 1 ? resume : { pageNumber: visible, sentenceIndex: 0 };
  }

  Promise.resolve(session.start(start)).catch((err) => {
    console.warn('Erro ao iniciar a leitura:', err);
    toaster.show(err?.message || 'Não foi possível começar a leitura.', { type: 'error' });
  });
}

function togglePlay() {
  const session = state.session;
  if (!session) {
    startReading();
    return;
  }
  switch (session.state) {
    case 'playing':
      session.pause();
      break;
    case 'loading':
      session.pause();
      break;
    case 'paused':
      state.engine?.unlock?.();
      Promise.resolve(session.resume()).catch(() => {});
      break;
    default:
      startReading();
  }
}

function stopReading() {
  const session = state.session;
  if (!session || session.state === 'idle' || session.state === 'finished') return;
  const pos = session.position;
  session.stop();
  if (pos) state.resumePos = pos;
  savePositionSoon.flush();
  clearHighlight();
  player.showIdleHint();
}

/** @param {'next' | 'previous'} direction */
function skip(direction) {
  const session = state.session;
  if (!session || !ACTIVE_STATES.includes(session.state)) return;
  if (direction === 'next') session.next();
  else session.previous();
}

// ---------- Salvar posição ----------
const savePositionSoon = debounce(() => {
  if (state.doc && state.resumePos) savePosition(state.doc.fingerprint, state.resumePos);
}, SAVE_POSITION_DELAY);

// ---------- Media Session (tela de bloqueio, fones, teclas de mídia) ----------
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => {
      if (state.session?.state === 'paused') Promise.resolve(state.session.resume()).catch(() => {});
      else if (state.session?.state !== 'playing') startReading();
    },
    pause: () => {
      if (state.session?.state === 'playing') state.session.pause();
    },
    stop: stopReading,
    nexttrack: () => skip('next'),
    previoustrack: () => skip('previous'),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Ação não suportada neste navegador.
    }
  }
}

/** @param {number | null} pageNumber null limpa os dados */
function updateMediaMetadata(pageNumber) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (!state.doc || pageNumber === null || typeof MediaMetadata === 'undefined') {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.doc.title,
      artist: `Página ${pageNumber} de ${state.doc.numPages}`,
      album: APP_NAME,
    });
  } catch {
    // Media Session indisponível.
  }
}

function setMediaPlaybackState(sessionState) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState =
      sessionState === 'playing' || sessionState === 'loading' ? 'playing' : sessionState === 'paused' ? 'paused' : 'none';
  } catch {
    // Ignora navegadores sem playbackState.
  }
}

// ---------- Atalhos de teclado ----------
function onKeydown(event) {
  if (event.defaultPrevented || event.isComposing) return;
  if (els.passwordDialog.open) return;

  if (event.key === 'Escape') {
    if (settings.isOpen) {
      event.preventDefault();
      settings.close();
    } else if (state.session && ACTIVE_STATES.includes(state.session.state)) {
      event.preventDefault();
      stopReading();
    }
    return;
  }

  if (settings.isOpen || !state.doc) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextEntry(event.target)) return;

  switch (event.key) {
    case ' ':
    case 'Spacebar':
      // Em botões, o Espaço já aciona o próprio botão.
      if (isActivatable(event.target)) return;
      event.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      if (!state.session || state.session.state === 'idle' || state.session.state === 'finished') return;
      event.preventDefault();
      skip('next');
      break;
    case 'ArrowLeft':
      if (!state.session || state.session.state === 'idle' || state.session.state === 'finished') return;
      event.preventDefault();
      skip('previous');
      break;
    case '+':
    case '=':
      event.preventDefault();
      state.viewer?.zoomIn();
      break;
    case '-':
    case '_':
      event.preventDefault();
      state.viewer?.zoomOut();
      break;
    default:
  }
}

document.addEventListener('keydown', onKeydown);

// Salva a posição e cala a voz ao sair da página (o Chrome às vezes continua falando).
window.addEventListener('pagehide', () => {
  savePositionSoon.flush();
  for (const engine of [state.engines.browser, state.engines.neural]) {
    try {
      engine?.cancel();
    } catch {
      // Nada sendo falado.
    }
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePositionSoon.flush();
});

// ---------- Início ----------
applyTheme(loadTheme());
setupMediaSession();
setupSpeech().catch((err) => {
  console.warn('Falha ao preparar a voz:', err);
  state.speechReady = true;
  if (!state.engine) setNoEngine();
});
// Já baixa o pdf.js em segundo plano para a primeira abertura ser mais rápida.
loadPdfModules().catch((err) => {
  console.warn('Falha ao carregar o pdf.js:', err);
  toaster.show(PDF_LOAD_ERROR, { type: 'warning', duration: 12000 });
});
