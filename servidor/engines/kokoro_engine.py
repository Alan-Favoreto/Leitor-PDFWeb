"""Motor Kokoro-82M (hexgrad, Apache-2.0): rápido, leve (~0,4 GB de VRAM), uma voz por idioma.

G2P pelo misaki: inglês com o próprio léxico (+ espeak para palavras desconhecidas), chinês
com jieba/pypinyin, japonês com pyopenjtalk (opcional) e os demais pelo espeak-ng, que vem
embutido no pacote espeakng-loader (não precisa instalar nada à mão).
"""

from __future__ import annotations

import logging
import sys

import numpy as np

from .base import EngineError, TTSEngine, Voice, chunk_text, has_modules
from .hub import hf_file

log = logging.getLogger('servidor')

SAMPLE_RATE = 24000

# id da voz → (nome exibido, idioma, padrão do idioma?)
# A primeira letra do id é o código de idioma do Kokoro; a segunda, o gênero.
VOICES: dict[str, tuple[str, str, bool]] = {
    # português do Brasil
    'pf_dora': ('Dora', 'pt', True),
    'pm_alex': ('Alex', 'pt', False),
    'pm_santa': ('Santa', 'pt', False),
    # inglês (EUA = a, Reino Unido = b)
    'af_heart': ('Heart (EUA)', 'en', True),
    'af_bella': ('Bella (EUA)', 'en', False),
    'af_nicole': ('Nicole (EUA)', 'en', False),
    'af_aoede': ('Aoede (EUA)', 'en', False),
    'af_kore': ('Kore (EUA)', 'en', False),
    'af_sarah': ('Sarah (EUA)', 'en', False),
    'am_michael': ('Michael (EUA)', 'en', False),
    'am_fenrir': ('Fenrir (EUA)', 'en', False),
    'am_puck': ('Puck (EUA)', 'en', False),
    'bf_emma': ('Emma (Reino Unido)', 'en', False),
    'bf_isabella': ('Isabella (Reino Unido)', 'en', False),
    'bm_george': ('George (Reino Unido)', 'en', False),
    'bm_fable': ('Fable (Reino Unido)', 'en', False),
    # espanhol
    'ef_dora': ('Dora', 'es', True),
    'em_alex': ('Alex', 'es', False),
    'em_santa': ('Santa', 'es', False),
    # francês
    'ff_siwis': ('Siwis', 'fr', True),
    # italiano
    'if_sara': ('Sara', 'it', True),
    'im_nicola': ('Nicola', 'it', False),
    # hindi
    'hf_alpha': ('Alpha', 'hi', True),
    'hf_beta': ('Beta', 'hi', False),
    'hm_omega': ('Omega', 'hi', False),
    'hm_psi': ('Psi', 'hi', False),
    # japonês (precisa de misaki[ja] / pyopenjtalk)
    'jf_alpha': ('Alpha', 'ja', True),
    'jf_gongitsune': ('Gongitsune', 'ja', False),
    'jf_nezumi': ('Nezumi', 'ja', False),
    'jf_tebukuro': ('Tebukuro', 'ja', False),
    'jm_kumo': ('Kumo', 'ja', False),
    # chinês (mandarim)
    'zf_xiaoxiao': ('Xiaoxiao', 'zh', True),
    'zf_xiaobei': ('Xiaobei', 'zh', False),
    'zf_xiaoni': ('Xiaoni', 'zh', False),
    'zf_xiaoyi': ('Xiaoyi', 'zh', False),
    'zm_yunjian': ('Yunjian', 'zh', False),
    'zm_yunxi': ('Yunxi', 'zh', False),
    'zm_yunxia': ('Yunxia', 'zh', False),
    'zm_yunyang': ('Yunyang', 'zh', False),
}

# módulos extras exigidos por idioma (além do kokoro/misaki base)
LANG_MODULES = {
    'ja': ('pyopenjtalk', 'fugashi', 'jaconv', 'mojimoji'),
    'zh': ('jieba', 'pypinyin', 'cn2an'),
    'en': ('spacy', 'en_core_web_sm'),
}
ALL_LANGS = ['pt', 'en', 'es', 'fr', 'it', 'hi', 'ja', 'zh']


def _quiet_loguru() -> None:
    """O kokoro usa loguru e avisa a cada pipeline; deixa só erros no terminal."""
    try:
        from loguru import logger
        logger.remove()
        logger.add(sys.stderr, level='ERROR')
    except Exception:  # noqa: BLE001
        pass


class KokoroEngine(TTSEngine):
    id = 'kokoro'
    name = 'Kokoro (rápido)'

    def __init__(self, config: dict):
        super().__init__(config)
        self.repo_id = config.get('repo_id', 'hexgrad/Kokoro-82M')
        self.revision = config.get('revision') or None
        self.speed = float(config.get('speed', 1.0))
        self.max_chunk = int(config.get('max_chunk_chars', 220))
        self.languages = list(ALL_LANGS)
        self._model = None
        self._pipelines: dict = {}
        self._voice_files: dict[str, str] = {}

    def check_available(self) -> str | None:
        missing = has_modules('torch', 'kokoro', 'misaki', 'espeakng_loader', 'phonemizer')
        if missing:
            return (f'Kokoro não instalado (falta o módulo "{missing}"). '
                    'Rode o instalador: scripts\\instalar.bat (Windows) ou scripts/instalar.sh.')
        self.languages = [lang for lang in ALL_LANGS
                          if not has_modules(*LANG_MODULES.get(lang, ()))]
        return None

    def voices(self) -> list[Voice]:
        out = []
        for vid, (label, lang, is_default) in VOICES.items():
            if lang not in self.languages:
                continue
            out.append(Voice(
                id=f'kokoro:{vid}', engine='kokoro', name=label,
                gender='f' if vid[1] == 'f' else 'm', languages=[lang],
                default_for=[lang] if is_default else [],
            ))
        return out

    # ------------------------------------------------------------------------------
    def download(self) -> None:
        hf_file(self.repo_id, 'config.json', revision=self.revision)
        hf_file(self.repo_id, 'kokoro-v1_0.pth', revision=self.revision)
        for vid, (_, lang, _) in VOICES.items():
            if lang in self.languages:
                self._voice_path(vid)

    def _voice_path(self, vid: str) -> str:
        path = self._voice_files.get(vid)
        if path is None:
            path = hf_file(self.repo_id, f'voices/{vid}.pt', revision=self.revision)
            self._voice_files[vid] = path
        return path

    def load(self, device: str) -> None:
        _quiet_loguru()
        import torch
        from kokoro import KModel

        config = hf_file(self.repo_id, 'config.json', revision=self.revision)
        weights = hf_file(self.repo_id, 'kokoro-v1_0.pth', revision=self.revision)
        model = KModel(repo_id=self.repo_id, config=config, model=weights)
        self._model = model.to(device).eval()
        self.device = device
        self.loaded = True
        # aquece (a 1ª inferência na GPU compila kernels e demora mais)
        try:
            with torch.inference_mode():
                self._run('pt', 'pf_dora', 'Olá.')
        except Exception as exc:  # noqa: BLE001 - aquecimento não é essencial
            log.debug('Aquecimento do Kokoro falhou: %s', exc)

    def unload(self) -> None:
        self._pipelines.clear()
        self._model = None
        self.loaded = False

    # ------------------------------------------------------------------------------
    def _pipeline(self, lang_code: str):
        pipe = self._pipelines.get(lang_code)
        if pipe is None:
            from kokoro import KPipeline
            try:
                pipe = KPipeline(lang_code=lang_code, repo_id=self.repo_id, model=self._model)
            except ImportError as exc:
                raise EngineError(
                    f'O Kokoro não tem o suporte a este idioma instalado ({exc}).',
                    'LANG_UNSUPPORTED', 422) from exc
            self._pipelines[lang_code] = pipe
        return pipe

    def _run(self, lang: str, vid: str, text: str) -> np.ndarray:
        pipe = self._pipeline(vid[0])
        voice_file = self._voice_path(vid)
        chunks = chunk_text(text, self.max_chunk)
        parts = []
        # cada pedaço numa linha: o KPipeline divide por \n e cada pedaço cabe no contexto
        for result in pipe('\n'.join(chunks), voice=voice_file, speed=self.speed,
                           split_pattern=r'\n+'):
            audio = result.audio
            if audio is not None and len(audio):
                parts.append(audio.detach().float().cpu().numpy())
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts)

    def synthesize(self, text: str, lang: str, voice: Voice) -> tuple[np.ndarray, int]:
        if not self.loaded:
            raise EngineError('O Kokoro não está carregado.', 'ENGINE_NOT_LOADED', 503)
        import torch

        vid = voice.id.split(':', 1)[1]
        with torch.inference_mode():
            audio = self._run(lang, vid, text)
        return audio, SAMPLE_RATE
