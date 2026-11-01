"""Interface comum dos motores de voz (TTSEngine) e utilitários compartilhados.

Regras para quem implementa um motor:
- O construtor é barato: nada de importar torch/modelo aqui (o servidor lista os motores
  na partida). `check_available()` só confere se as dependências existem.
- `load()`, `synthesize()` e `unload()` são chamados SEMPRE na mesma thread (a fila da GPU),
  um de cada vez. Não precisam de trava própria.
- `synthesize()` devolve (float32 mono em [-1, 1], taxa de amostragem nativa). O servidor faz o
  corte de silêncio, a normalização e o WAV.
"""

from __future__ import annotations

import importlib.util
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np


class EngineError(Exception):
    """Erro com mensagem pronta para o usuário (pt-BR), código e status HTTP."""

    def __init__(self, message: str, code: str = 'ENGINE_ERROR', status: int = 503):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


@dataclass
class Voice:
    id: str                        # "<motor>:<nome>", ex.: "kokoro:pf_dora"
    engine: str
    name: str
    gender: str | None             # "f" | "m" | None (desconhecido)
    languages: list[str]
    default_for: list[str] = field(default_factory=list)   # idiomas em que é a voz padrão
    description: str | None = None

    def to_json(self) -> dict:
        data = {
            'id': self.id,
            'engine': self.engine,
            'name': self.name,
            'gender': self.gender,
            'languages': list(self.languages),
            'default': bool(self.default_for),
            'defaultFor': list(self.default_for),
        }
        if self.description:
            data['description'] = self.description
        return data


def has_modules(*names: str) -> str | None:
    """Devolve o primeiro módulo que falta (ou None se todos existem), sem importá-los."""
    for name in names:
        try:
            if importlib.util.find_spec(name) is None:
                return name
        except (ImportError, ValueError):
            return name
    return None


_SENTENCE_END = re.compile(r'(?<=[.!?…。！？;:])\s+')
_SOFT_BREAK = re.compile(r'(?<=[,،、，—–-])\s+')


def chunk_text(text: str, max_chars: int) -> list[str]:
    """Divide o texto em pedaços de até `max_chars`, preferindo fim de frase, depois vírgula,
    depois espaço. Textos curtos voltam inteiros."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []
    pieces: list[str] = []
    for sentence in _SENTENCE_END.split(text):
        if len(sentence) <= max_chars:
            pieces.append(sentence)
            continue
        for part in _SOFT_BREAK.split(sentence):
            while len(part) > max_chars:
                cut = part.rfind(' ', 0, max_chars)
                if cut < max_chars // 3:
                    cut = max_chars
                pieces.append(part[:cut])
                part = part[cut:].lstrip()
            if part:
                pieces.append(part)
    # junta pedaços pequenos vizinhos para não picotar a entonação
    chunks: list[str] = []
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if chunks and len(chunks[-1]) + 1 + len(piece) <= max_chars:
            chunks[-1] = f'{chunks[-1]} {piece}'
        else:
            chunks.append(piece)
    return chunks


class TTSEngine(ABC):
    id: str = ''
    name: str = ''
    #: idiomas que o motor fala (pode ser recalculado em check_available)
    languages: list[str] = []

    def __init__(self, config: dict):
        self.config = config
        self.loaded = False
        self.device: str | None = None
        self.error: str | None = None      # último erro de carga (pt-BR), para o /status

    # --- disponibilidade -------------------------------------------------------------
    @abstractmethod
    def check_available(self) -> str | None:
        """None se pode ser usado; senão, o motivo em pt-BR (ex.: pacote não instalado)."""

    # --- vozes -----------------------------------------------------------------------
    @abstractmethod
    def voices(self) -> list[Voice]:
        ...

    def voice_by_id(self, voice_id: str) -> Voice | None:
        for v in self.voices():
            if v.id == voice_id:
                return v
        return None

    def default_voice(self, lang: str) -> Voice | None:
        candidates = [v for v in self.voices() if lang in v.languages]
        for v in candidates:
            if lang in v.default_for:
                return v
        return candidates[0] if candidates else None

    # --- ciclo de vida (sempre na thread da GPU) ------------------------------------
    @abstractmethod
    def download(self) -> None:
        """Baixa os arquivos do modelo para o cache do Hugging Face (sem carregar)."""

    @abstractmethod
    def load(self, device: str) -> None:
        ...

    @abstractmethod
    def unload(self) -> None:
        ...

    @abstractmethod
    def synthesize(self, text: str, lang: str, voice: Voice) -> tuple[np.ndarray, int]:
        ...
