"""Configuração: padrões + servidor/config.json opcional (não versionado) + argumentos.

Ordem de prioridade: argumentos da linha de comando > config.json > padrões abaixo.
"""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path

log = logging.getLogger('servidor')

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent
WEB_DIR = PROJECT_DIR / 'web'
CONFIG_FILE = PACKAGE_DIR / 'config.json'
# Áudios de referência para vozes extras do Chatterbox (clonagem). Não versionar.
VOICES_DIR = PACKAGE_DIR / 'vozes'

DEFAULTS: dict = {
    # 127.0.0.1 = só este computador. Use --host 0.0.0.0 para abrir na rede local.
    'host': '127.0.0.1',
    'port': 8090,
    'default_engine': 'kokoro',
    'device': 'auto',              # auto | cuda | cpu
    'preload': False,              # carrega o motor padrão ao iniciar
    'idle_unload_minutes': 10,     # 0 = nunca descarrega sozinho
    'max_text_chars': 600,
    'max_queue': 24,               # pedidos esperando a GPU; acima disso responde 503
    'cache_mb': 128,               # cache LRU de áudios gerados (memória)
    'allowed_hosts': [],           # nomes extras aceitos no cabeçalho Host (ex.: "meupc.local")
    'kokoro': {
        'repo_id': 'hexgrad/Kokoro-82M',
        # commit fixo do repositório do modelo (reprodutível); "" = sempre o mais novo
        'revision': 'f3ff3571791e39611d31c381e3a41a3af07b4987',
        'speed': 1.0,
        'max_chunk_chars': 220,
    },
    'chatterbox': {
        'repo_id': 'ResembleAI/chatterbox',
        'revision': '5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18',
        'model': 'v3',             # v3 (recomendado) | v2
        'exaggeration': 0.5,
        'cfg_weight': 0.5,
        'temperature': 0.8,
        'max_chunk_chars': 260,
    },
}


def _merge(base: dict, extra: dict, path: str = '') -> dict:
    """Mescla `extra` em `base` (recursivo), ignorando chaves desconhecidas com aviso."""
    for key, value in extra.items():
        if key.startswith('_'):
            continue  # comentários no JSON
        if key not in base:
            log.warning('config.json: chave desconhecida ignorada: %s%s', path, key)
            continue
        if isinstance(base[key], dict):
            if isinstance(value, dict):
                _merge(base[key], value, f'{path}{key}.')
            else:
                log.warning('config.json: "%s%s" deveria ser um objeto; ignorado.', path, key)
        elif base[key] is not None and not isinstance(value, type(base[key])) and not (
            isinstance(base[key], float) and isinstance(value, int)
        ):
            log.warning('config.json: "%s%s" com tipo inválido; usando o padrão.', path, key)
        else:
            base[key] = value
    return base


def load_config() -> dict:
    """Devolve a configuração efetiva (padrões + config.json)."""
    cfg = copy.deepcopy(DEFAULTS)
    if CONFIG_FILE.is_file():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                _merge(cfg, data)
                log.info('Configuração lida de %s', CONFIG_FILE)
            else:
                log.warning('config.json ignorado: o conteúdo precisa ser um objeto JSON.')
        except (OSError, ValueError) as exc:
            log.warning('config.json ignorado (erro de leitura): %s', exc)
    return cfg
