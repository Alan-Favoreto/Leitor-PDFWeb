"""Motor Chatterbox Multilingual V3 (Resemble AI, MIT): mais expressivo, 23 idiomas, mais pesado.

- ~3,5 GB de VRAM em fp32; na RTX 3060 gera um pouco mais devagar que o tempo real.
- Voz "padrao": a voz embutida do modelo (conds.pt), fala todos os idiomas.
- Vozes extras: coloque um áudio limpo de 7 a 20 s (WAV/FLAC/MP3/OGG) em servidor/vozes/; o
  nome do arquivo vira o nome da voz. Para soar nativo num idioma, use uma referência falada
  nesse idioma (o sotaque da referência passa para a fala).
- O áudio sai com a marca d'água inaudível "Perth" da Resemble AI (faz parte do pacote).
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import re
import zlib

import numpy as np

from ..config import VOICES_DIR
from .base import EngineError, TTSEngine, Voice, chunk_text, has_modules
from .hub import hf_snapshot, offline_hub

log = logging.getLogger('servidor')

LANGUAGES = ['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms',
             'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh']
T3_FILES = {'v2': 't3_mtl23ls_v2.safetensors', 'v3': 't3_mtl23ls_v3.safetensors'}
AUDIO_EXT = ('.wav', '.flac', '.mp3', '.ogg')
_SAFE_NAME = re.compile(r'[^a-z0-9_-]+')
PAUSE_BETWEEN_CHUNKS = 0.18  # segundos


def _voice_files() -> dict[str, str]:
    """Vozes extras: nome seguro → caminho do arquivo de referência."""
    out: dict[str, str] = {}
    if not VOICES_DIR.is_dir():
        return out
    for path in sorted(VOICES_DIR.iterdir()):
        if path.is_file() and path.suffix.lower() in AUDIO_EXT:
            name = _SAFE_NAME.sub('-', path.stem.lower()).strip('-')[:40]
            if name and name != 'padrao' and name not in out:
                out[name] = str(path)
    return out


class ChatterboxEngine(TTSEngine):
    id = 'chatterbox'
    name = 'Chatterbox (expressivo)'

    def __init__(self, config: dict):
        super().__init__(config)
        self.languages = list(LANGUAGES)
        self.repo_id = config.get('repo_id', 'ResembleAI/chatterbox')
        self.revision = config.get('revision') or None
        variant = str(config.get('model', 'v3')).lower()
        self.variant = variant if variant in T3_FILES else 'v3'
        self.exaggeration = float(config.get('exaggeration', 0.5))
        self.cfg_weight = float(config.get('cfg_weight', 0.5))
        self.temperature = float(config.get('temperature', 0.8))
        self.max_chunk = int(config.get('max_chunk_chars', 260))
        self._model = None
        self._conds: dict[str, object] = {}

    def check_available(self) -> str | None:
        missing = has_modules('torch', 'chatterbox', 'perth', 'librosa', 's3tokenizer',
                              'diffusers', 'conformer', 'pkg_resources')
        if missing:
            return ('Chatterbox não instalado (opcional). Para usar, rode '
                    'scripts\\instalar.bat -ComChatterbox (Windows) ou '
                    f'scripts/instalar.sh --com-chatterbox (Linux). Falta: "{missing}".')
        return None

    def voices(self) -> list[Voice]:
        out = [Voice(id='chatterbox:padrao', engine='chatterbox', name='Padrão (multilíngue)',
                     gender='f', languages=list(self.languages),
                     default_for=list(self.languages),
                     description='Voz embutida do modelo; fala todos os idiomas.')]
        for name in _voice_files():
            out.append(Voice(id=f'chatterbox:{name}', engine='chatterbox',
                             name=name.replace('-', ' ').replace('_', ' ').title(),
                             gender=None, languages=list(self.languages),
                             description='Voz clonada de servidor/vozes/.'))
        return out

    # ------------------------------------------------------------------------------
    def _patterns(self) -> list[str]:
        return ['ve.pt', T3_FILES[self.variant], 's3gen.pt', 'grapheme_mtl_merged_expanded_v1.json',
                'conds.pt', 'Cangjie5_TC.json']

    def download(self) -> None:
        hf_snapshot(self.repo_id, self._patterns(), revision=self.revision)

    def load(self, device: str) -> None:
        os.environ.setdefault('TQDM_DISABLE', '1')  # barra de progresso a cada frase
        for name in ('chatterbox', 'chatterbox.models.t3.t3'):
            logging.getLogger(name).setLevel(logging.WARNING)
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        ckpt = hf_snapshot(self.repo_id, self._patterns(), revision=self.revision)
        # Com os arquivos já no cache, carrega em modo offline: o tokenizador do Chatterbox
        # chamaria o Hugging Face de novo (e falharia sem internet). O pacote também imprime
        # mensagens soltas na carga; ficam escondidas fora do modo --verbose.
        quiet = log.getEffectiveLevel() > logging.DEBUG
        with offline_hub(), contextlib.redirect_stdout(io.StringIO()) if quiet                 else contextlib.nullcontext():
            model = ChatterboxMultilingualTTS.from_local(ckpt, device,
                                                         t3_model=T3_FILES[self.variant])
        self._model = model
        self._conds = {'padrao': model.conds}
        self.device = device
        self.loaded = True
        try:  # aquecimento curto
            with torch.inference_mode():
                model.generate('Olá.', language_id='pt')
        except Exception as exc:  # noqa: BLE001
            log.debug('Aquecimento do Chatterbox falhou: %s', exc)

    def unload(self) -> None:
        self._conds.clear()
        self._model = None
        self.loaded = False

    def _conditionals(self, name: str):
        conds = self._conds.get(name)
        if conds is not None:
            return conds
        path = _voice_files().get(name)
        if not path:
            raise EngineError('Voz não encontrada em servidor/vozes/.', 'VOICE_UNKNOWN', 422)
        log.info('Preparando a voz "%s" a partir de %s…', name, os.path.basename(path))
        try:
            self._model.prepare_conditionals(path, exaggeration=self.exaggeration)
        except Exception as exc:  # noqa: BLE001
            raise EngineError(f'Não consegui ler o áudio de referência da voz "{name}". '
                              'Use um WAV/FLAC/MP3 limpo de 7 a 20 segundos.',
                              'VOICE_FILE_INVALID', 422) from exc
        conds = self._model.conds
        self._conds[name] = conds
        return conds

    def synthesize(self, text: str, lang: str, voice: Voice) -> tuple[np.ndarray, int]:
        if not self.loaded or self._model is None:
            raise EngineError('O Chatterbox não está carregado.', 'ENGINE_NOT_LOADED', 503)
        import torch

        model = self._model
        model.conds = self._conditionals(voice.id.split(':', 1)[1])
        sr = int(model.sr)
        # semente fixa por texto: o mesmo trecho soa igual se for gerado de novo
        seed = zlib.crc32(f'{voice.id}|{lang}|{text}'.encode('utf-8')) & 0x7FFFFFFF
        torch.manual_seed(seed)
        parts: list[np.ndarray] = []
        gap = np.zeros(int(sr * PAUSE_BETWEEN_CHUNKS), dtype=np.float32)
        with torch.inference_mode():
            for chunk in chunk_text(text, self.max_chunk):
                wav = model.generate(chunk, language_id=lang, exaggeration=self.exaggeration,
                                     cfg_weight=self.cfg_weight, temperature=self.temperature)
                audio = wav.detach().float().cpu().numpy().reshape(-1)
                if parts:
                    parts.append(gap)
                parts.append(audio)
        if not parts:
            return np.zeros(0, dtype=np.float32), sr
        return np.concatenate(parts), sr
