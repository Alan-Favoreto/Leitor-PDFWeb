"""TTSService: escolhe motor/voz, carrega sob demanda, fila única na GPU, cache e descarga.

Tudo que toca no modelo (carregar, gerar, descarregar) roda numa única thread ("gpu"), então
só um pedido gera por vez e o loop do aiohttp nunca trava.
"""

from __future__ import annotations

import asyncio
import gc
import logging
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from . import __version__
from .audio import postprocess, silence, to_wav_bytes
from .audio_cache import AudioCache, CachedAudio
from .engines import ENGINE_CLASSES, EngineError, TTSEngine, Voice

log = logging.getLogger('servidor')

_LANG_RE = re.compile(r'^[a-z]{2,3}$')
_CTRL = re.compile(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏  ﻿]')
_HAS_WORD = re.compile(r'\w', re.UNICODE)


class Cancelled(Exception):
    """O navegador desistiu do pedido antes de ele chegar à GPU."""


def fmt(value: float, digits: int = 1) -> str:
    """Número com vírgula decimal (pt-BR)."""
    return f'{value:.{digits}f}'.replace('.', ',')


def detect_device(requested: str) -> tuple[str, str | None, float | None]:
    """Devolve (device, nome da GPU, VRAM total em GB)."""
    import torch

    requested = (requested or 'auto').lower()
    if requested not in ('auto', 'cuda', 'cpu'):
        log.warning('--device "%s" desconhecido; usando auto.', requested)
        requested = 'auto'
    if requested in ('auto', 'cuda'):
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            return 'cuda', torch.cuda.get_device_name(0), props.total_memory / 1024 ** 3
        if requested == 'cuda':
            log.warning('CUDA pedida, mas o PyTorch não encontrou GPU NVIDIA. Usando a CPU.')
    return 'cpu', None, None


def clean_text(text: str) -> str:
    text = unicodedata.normalize('NFC', text)
    text = _CTRL.sub(' ', text)
    return ' '.join(text.split())


def normalize_lang(value) -> str | None:
    """'pt-BR' → 'pt'. None se o formato for inválido."""
    if not isinstance(value, str):
        return None
    base = value.strip().lower().replace('_', '-').split('-', 1)[0]
    return base if _LANG_RE.match(base) else None


class TTSService:
    def __init__(self, cfg: dict, device: str, gpu_name: str | None, gpu_total_gb: float | None):
        self.cfg = cfg
        self.device = device
        self.gpu_name = gpu_name
        self.gpu_total_gb = gpu_total_gb
        self.max_text = int(cfg['max_text_chars'])
        self.max_queue = int(cfg['max_queue'])
        self.idle_seconds = max(0.0, float(cfg['idle_unload_minutes']) * 60.0)
        self.cache = AudioCache(int(cfg['cache_mb']) * 1024 * 1024)
        self.engines: dict[str, TTSEngine] = {}
        self.unavailable: dict[str, str] = {}
        for engine_id, cls in ENGINE_CLASSES.items():
            engine = cls(cfg.get(engine_id, {}))
            self.engines[engine_id] = engine
            reason = engine.check_available()
            if reason:
                self.unavailable[engine_id] = reason
        default = cfg.get('default_engine', 'kokoro')
        if default not in self.engines:
            log.warning('Motor padrão "%s" desconhecido; usando kokoro.', default)
            default = 'kokoro'
        if default in self.unavailable:
            fallback = next((e for e in self.engines if e not in self.unavailable), None)
            if fallback and fallback != default:
                log.warning('Motor padrão "%s" indisponível; usando "%s".', default, fallback)
                default = fallback
        self.default_engine = default
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='gpu')
        self._pending = 0
        self._loading: set[str] = set()
        self._last_used: dict[str, float] = {}
        self._inflight: dict[tuple, dict] = {}
        self._idle_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ informação
    def known_languages(self) -> set[str]:
        langs: set[str] = set()
        for engine in self.engines.values():
            langs.update(engine.languages)
        return langs

    def available_engines(self) -> list[TTSEngine]:
        return [e for eid, e in self.engines.items() if eid not in self.unavailable]

    def status(self) -> dict:
        engines = []
        for eid, engine in self.engines.items():
            engines.append({
                'id': eid,
                'name': engine.name,
                'available': eid not in self.unavailable,
                'loaded': engine.loaded,
                'loading': eid in self._loading,
                'languages': list(engine.languages),
                'error': self.unavailable.get(eid) or engine.error,
            })
        data = {
            'ok': True,
            'version': __version__,
            'device': self.device,
            'gpu': self.gpu_name,
            'defaultEngine': self.default_engine,
            'engines': engines,
            'maxTextLength': self.max_text,
            'idleUnloadMinutes': self.idle_seconds / 60.0,
            'queue': self._pending,
            'cache': self.cache.stats(),
        }
        mem = self._gpu_memory()
        if mem:
            data['vram'] = mem
        return data

    def voices(self, engine_id: str | None = None) -> list[dict]:
        out = []
        for engine in self.available_engines():
            if engine_id and engine.id != engine_id:
                continue
            out.extend(v.to_json() for v in engine.voices())
        return out

    def _gpu_memory(self) -> dict | None:
        if self.device != 'cuda':
            return None
        try:
            import torch
            return {
                'allocatedMB': round(torch.cuda.memory_allocated() / 1024 ** 2),
                'reservedMB': round(torch.cuda.memory_reserved() / 1024 ** 2),
                'totalMB': round((self.gpu_total_gb or 0) * 1024),
            }
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------ validação
    def resolve(self, text, lang, voice_id, engine_id) -> tuple[str, str, TTSEngine, Voice]:
        """Valida o pedido. Devolve (texto limpo, idioma, motor, voz) ou lança EngineError."""
        if not isinstance(text, str):
            raise EngineError('Envie o texto a ser lido no campo "text".', 'TEXT_REQUIRED', 400)
        text = clean_text(text)
        if not text:
            raise EngineError('O texto está vazio.', 'TEXT_REQUIRED', 400)
        if len(text) > self.max_text:
            raise EngineError(f'Texto longo demais ({len(text)} caracteres). O máximo por pedido '
                              f'é {self.max_text}; divida em frases menores.', 'TEXT_TOO_LONG', 400)

        if voice_id is not None and not isinstance(voice_id, str):
            raise EngineError('O campo "voice" precisa ser texto.', 'VOICE_INVALID', 400)
        if engine_id is not None and not isinstance(engine_id, str):
            raise EngineError('O campo "engine" precisa ser texto.', 'ENGINE_INVALID', 400)
        voice_id = voice_id.strip() if voice_id else None
        engine_id = engine_id.strip().lower() if engine_id else None
        if not engine_id and voice_id and ':' in voice_id:
            engine_id = voice_id.split(':', 1)[0].lower()
        engine_id = engine_id or self.default_engine
        if engine_id not in self.engines:
            raise EngineError(f'Motor de voz desconhecido: "{engine_id[:40]}". '
                              f'Opções: {", ".join(self.engines)}.', 'ENGINE_UNKNOWN', 400)
        engine = self.engines[engine_id]

        if lang is None or lang == '':
            raise EngineError('Informe o idioma do texto no campo "lang" (ex.: "pt").',
                              'LANG_REQUIRED', 400)
        norm = normalize_lang(lang)
        if norm is None:
            raise EngineError('Idioma inválido. Use o código de duas letras, ex.: "pt", "en".',
                              'LANG_INVALID', 400)
        if norm not in self.known_languages():
            raise EngineError(f'Nenhum motor de voz fala o idioma "{norm}".',
                              'LANG_UNSUPPORTED', 422)
        if engine_id in self.unavailable:
            raise EngineError(self.unavailable[engine_id], 'ENGINE_UNAVAILABLE', 503)
        if norm not in engine.languages:
            raise EngineError(f'O motor {engine.name} não fala o idioma "{norm}". Idiomas: '
                              f'{", ".join(engine.languages)}.', 'LANG_UNSUPPORTED', 422)

        voice = None
        if voice_id:
            owner = voice_id.split(':', 1)[0].lower() if ':' in voice_id else None
            if owner not in self.engines or self.engines[owner].voice_by_id(voice_id) is None:
                raise EngineError(f'Voz desconhecida: "{voice_id[:60]}". '
                                  'Veja a lista em /api/tts/voices.', 'VOICE_UNKNOWN', 422)
            if owner == engine_id:
                candidate = engine.voice_by_id(voice_id)
                if candidate and norm in candidate.languages:
                    voice = candidate
        if voice is None:  # sem voz, ou a voz escolhida não fala este idioma
            voice = engine.default_voice(norm)
        if voice is None:
            raise EngineError(f'O motor {engine.name} não tem voz para "{norm}".',
                              'LANG_UNSUPPORTED', 422)
        return text, norm, engine, voice

    # ------------------------------------------------------------------ geração
    async def synthesize(self, text: str, lang: str, engine: TTSEngine, voice: Voice,
                         is_cancelled: Callable[[], bool] = lambda: False
                         ) -> tuple[CachedAudio, bool]:
        """Devolve (áudio, veio_do_cache)."""
        key = AudioCache.key(engine.id, voice.id, lang, text)
        cached = self.cache.get(key)
        if cached is not None:
            self._last_used[engine.id] = time.monotonic()
            return cached, True

        entry = self._inflight.get(key)
        if entry is None:  # ninguém gerando este mesmo trecho: entra na fila
            if self._pending >= self.max_queue:
                raise EngineError('O servidor está ocupado com muitos pedidos. Tente de novo.',
                                  'QUEUE_FULL', 503)
            checks: list[Callable[[], bool]] = []
            entry = {'checks': checks}
            loop = asyncio.get_running_loop()
            self._pending += 1

            def all_gave_up() -> bool:
                return bool(checks) and all(c() for c in checks)

            future = loop.run_in_executor(self._executor, self._job, engine, voice, lang, text,
                                          all_gave_up)
            entry['future'] = future
            self._inflight[key] = entry

            def done(_f, key=key):
                self._pending -= 1
                self._inflight.pop(key, None)

            future.add_done_callback(done)
        entry['checks'].append(is_cancelled)
        result: CachedAudio = await asyncio.shield(entry['future'])
        return result, False

    def _ensure_loaded(self, engine: TTSEngine) -> None:
        """(thread da GPU) Carrega o motor se preciso."""
        if engine.loaded:
            return
        where = 'na GPU' if self.device == 'cuda' else 'na CPU'
        log.info('Carregando %s %s… (a primeira vez baixa o modelo)', engine.name, where)
        self._loading.add(engine.id)
        t0 = time.perf_counter()
        try:
            try:
                engine.load(self.device)
            except Exception as exc:  # noqa: BLE001
                others = [e for e in self.engines.values() if e is not engine and e.loaded]
                if not (_is_oom(exc) and others):
                    raise
                # falta VRAM: descarrega o outro motor e tenta mais uma vez
                self._cleanup_after_failure(engine)
                self._unload([e.id for e in others], f'liberando VRAM para {engine.name}')
                engine.load(self.device)
        except EngineError:
            self._cleanup_after_failure(engine)
            raise
        except Exception as exc:  # noqa: BLE001
            self._cleanup_after_failure(engine)
            if _is_oom(exc):
                engine.error = ('Falta memória na placa de vídeo para carregar este motor. '
                                'Feche programas que usam a GPU ou use --device cpu.')
                log.error('Sem VRAM para carregar %s.', engine.name)
                raise EngineError(engine.error, 'GPU_OUT_OF_MEMORY', 503) from exc
            log.exception('Falha ao carregar %s', engine.name)
            engine.error = (f'Falha ao carregar {engine.name}: {type(exc).__name__}. '
                            'Veja o terminal do servidor.')
            raise EngineError(engine.error, 'LOAD_FAILED', 503) from exc
        finally:
            self._loading.discard(engine.id)
        engine.error = None
        extra = ''
        mem = self._gpu_memory()
        if mem:
            extra = f' (VRAM do servidor: {fmt(mem["allocatedMB"] / 1024)} GB)'
        log.info('%s pronto em %s s%s.', engine.name, fmt(time.perf_counter() - t0), extra)

    def _cleanup_after_failure(self, engine: TTSEngine) -> None:
        try:
            engine.unload()
        except Exception:  # noqa: BLE001
            pass
        self._free_memory()

    def _free_memory(self) -> None:
        gc.collect()
        if self.device == 'cuda':
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass

    def _job(self, engine: TTSEngine, voice: Voice, lang: str, text: str,
             gave_up: Callable[[], bool]) -> CachedAudio:
        """(thread da GPU) Gera um áudio, guarda no cache e devolve."""
        key = AudioCache.key(engine.id, voice.id, lang, text)
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        if gave_up():
            raise Cancelled()
        self._ensure_loaded(engine)
        self._last_used[engine.id] = time.monotonic()
        t0 = time.perf_counter()
        sr = 24000
        try:
            if _HAS_WORD.search(text):
                audio, sr = engine.synthesize(text, lang, voice)
            else:
                audio = silence(sr, 0.0)
        except EngineError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._free_memory()
            if _is_oom(exc):
                log.error('Sem VRAM durante a geração (%s).', engine.name)
                raise EngineError('Falta memória na placa de vídeo. Feche programas que usam a '
                                  'GPU ou use --device cpu.', 'GPU_OUT_OF_MEMORY', 503) from exc
            log.exception('Falha ao gerar áudio com %s', engine.name)
            raise EngineError('Falha ao gerar o áudio. Veja o terminal do servidor.',
                              'GENERATION_FAILED', 500) from exc
        finally:
            self._last_used[engine.id] = time.monotonic()
        elapsed = time.perf_counter() - t0
        spoken = audio.size > 0
        audio = postprocess(audio, sr)
        if audio.size < int(sr * 0.2):  # nada audível: devolve um silêncio curto
            audio = silence(sr, 0.25)
        duration = audio.size / sr
        item = CachedAudio(wav=to_wav_bytes(audio, sr), duration=duration, engine=engine.id,
                           voice=voice.id, lang=lang)
        self.cache.put(key, item)
        if not spoken:
            log.info('[%s] %s, %d caract. sem nada para falar → silêncio curto', voice.id, lang,
                     len(text))
            return item
        speed = duration / elapsed if elapsed > 0 else 0.0
        log.info('[%s] %s, %d caract. → %s s de áudio em %s s (%s× tempo real)',
                 voice.id, lang, len(text), fmt(duration), fmt(elapsed, 2), fmt(speed))
        return item

    # ------------------------------------------------------------------ carga/descarga
    async def preload(self, engine_id: str | None = None) -> None:
        engine = self.engines.get(engine_id or self.default_engine)
        if engine is None or engine.id in self.unavailable:
            return
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(self._executor, self._ensure_loaded, engine)
            self._last_used[engine.id] = time.monotonic()
        except EngineError as exc:
            log.error('Pré-carregamento falhou: %s', exc.message)

    def _unload(self, engine_ids: list[str], reason: str) -> list[str]:
        """(thread da GPU)"""
        done = []
        for eid in engine_ids:
            engine = self.engines[eid]
            if engine.loaded:
                engine.unload()
                done.append(eid)
        if done:
            self._free_memory()
            names = ', '.join(self.engines[e].name for e in done)
            log.info('%s descarregado (%s); VRAM liberada.', names, reason)
        return done

    async def unload(self, engine_id: str | None = None) -> list[str]:
        ids = [engine_id] if engine_id else list(self.engines)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._unload, ids, 'pedido do navegador')

    async def _idle_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(15)
            if self.idle_seconds <= 0 or self._pending:
                continue
            now = time.monotonic()
            stale = [eid for eid, e in self.engines.items()
                     if e.loaded and now - self._last_used.get(eid, now) >= self.idle_seconds]
            if stale:
                minutes = fmt(self.idle_seconds / 60, 0)
                await loop.run_in_executor(self._executor, self._unload, stale,
                                           f'{minutes} min sem uso')

    def start(self) -> None:
        self._idle_task = asyncio.get_running_loop().create_task(self._idle_loop())

    async def close(self) -> None:
        if self._idle_task:
            self._idle_task.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ uso fora do servidor
    def run_blocking(self, fn, *args):
        """Roda `fn` na thread da GPU e espera (para --baixar-modelos e --testar)."""
        return self._executor.submit(fn, *args).result()


def _is_oom(exc: BaseException) -> bool:
    name = type(exc).__name__
    return name == 'OutOfMemoryError' or 'out of memory' in str(exc).lower()
