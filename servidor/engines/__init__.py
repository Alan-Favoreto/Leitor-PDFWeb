"""Motores de voz disponíveis. A ordem define a ordem no /api/tts/status."""

from __future__ import annotations

from .base import EngineError, TTSEngine, Voice
from .chatterbox_engine import ChatterboxEngine
from .kokoro_engine import KokoroEngine

ENGINE_CLASSES: dict[str, type[TTSEngine]] = {
    'kokoro': KokoroEngine,
    'chatterbox': ChatterboxEngine,
}

__all__ = ['ENGINE_CLASSES', 'EngineError', 'TTSEngine', 'Voice']
