"""Cache LRU em memória dos áudios gerados, limitado pelo total de bytes."""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass


@dataclass(frozen=True)
class CachedAudio:
    wav: bytes
    duration: float
    engine: str
    voice: str   # id completo, ex.: "kokoro:pf_dora"
    lang: str


class AudioCache:
    def __init__(self, max_bytes: int):
        self.max_bytes = max(0, int(max_bytes))
        self._items: OrderedDict[tuple, CachedAudio] = OrderedDict()
        self._size = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key(engine: str, voice: str, lang: str, text: str) -> tuple:
        return (engine, voice, lang, text)

    def get(self, key: tuple) -> CachedAudio | None:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                self.misses += 1
                return None
            self._items.move_to_end(key)
            self.hits += 1
            return item

    def put(self, key: tuple, item: CachedAudio) -> None:
        size = len(item.wav)
        if size > self.max_bytes:
            return
        with self._lock:
            old = self._items.pop(key, None)
            if old is not None:
                self._size -= len(old.wav)
            self._items[key] = item
            self._size += size
            while self._size > self.max_bytes and self._items:
                _, removed = self._items.popitem(last=False)
                self._size -= len(removed.wav)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._size = 0

    def stats(self) -> dict:
        with self._lock:
            return {'items': len(self._items), 'bytes': self._size, 'maxBytes': self.max_bytes,
                    'hits': self.hits, 'misses': self.misses}
