#!/usr/bin/env bash
# Inicia o servidor do Leitor de PDF com voz usando o .venv do projeto.
# Todos os argumentos vão para "python -m servidor" (ex.: --preload, --port 8091).
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -x "$RAIZ/.venv/bin/python" ]; then
  echo "A voz neural ainda não foi instalada. Rode primeiro: scripts/instalar.sh" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$RAIZ/.venv/bin/activate"
export PYTHONUTF8=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1
cd "$RAIZ"
exec python -m servidor "$@"
