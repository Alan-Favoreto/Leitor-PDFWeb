"""Download de arquivos do Hugging Face usando primeiro o cache local (funciona offline)."""

from __future__ import annotations

import contextlib
import logging
import os

log = logging.getLogger('servidor')

os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')


def hf_file(repo_id: str, filename: str, *, revision: str | None = None) -> str:
    """Caminho local de um arquivo do repositório; baixa só se ainda não estiver no cache."""
    from huggingface_hub import hf_hub_download

    try:
        return hf_hub_download(repo_id, filename, revision=revision, local_files_only=True)
    except Exception:  # noqa: BLE001 - qualquer falha local = tentar baixar
        log.info('Baixando %s/%s…', repo_id, filename)
        return hf_hub_download(repo_id, filename, revision=revision)


def hf_snapshot(repo_id: str, patterns: list[str], *, revision: str | None = None) -> str:
    """Pasta local com os arquivos pedidos de um repositório (baixa o que faltar)."""
    from huggingface_hub import snapshot_download

    try:
        path = snapshot_download(repo_id, allow_patterns=patterns, revision=revision,
                                 local_files_only=True)
        missing = [p for p in patterns if '*' not in p and not os.path.exists(os.path.join(path, p))]
        if not missing:
            return path
    except Exception:  # noqa: BLE001
        pass
    log.info('Baixando %s (%s)… pode levar alguns minutos na primeira vez.',
             repo_id, ', '.join(patterns))
    return snapshot_download(repo_id, allow_patterns=patterns, revision=revision)


@contextlib.contextmanager
def offline_hub():
    """Durante o bloco, o huggingface_hub só usa o cache local (sem rede)."""
    try:
        from huggingface_hub import constants
    except ImportError:
        yield
        return
    old = constants.HF_HUB_OFFLINE
    constants.HF_HUB_OFFLINE = True
    try:
        yield
    finally:
        constants.HF_HUB_OFFLINE = old
