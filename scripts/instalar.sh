#!/usr/bin/env bash
# Instala a voz neural local do Leitor de PDF (Linux; no macOS funciona só com CPU, sem teste).
#
#   scripts/instalar.sh                    # pergunta sobre o Chatterbox
#   scripts/instalar.sh --com-chatterbox   # instala também o Chatterbox
#   scripts/instalar.sh --sem-chatterbox   # não instala (e remove, se existir)
#   scripts/instalar.sh --cpu              # força PyTorch de CPU
#   scripts/instalar.sh --sem-modelos      # não baixa os modelos agora
#   scripts/instalar.sh --sem-teste        # pula o teste no final
#
# Pode rodar de novo quando quiser: só faz o que falta.
set -uo pipefail

TORCH_VERSION="2.8.0"
PYTHON_VERSION="3.11"
CHATTERBOX_PKG="chatterbox-tts @ https://github.com/resemble-ai/chatterbox/archive/5de7a54aa4e5e2baadb0182dde554908b48b85c2.zip"

COM_CB="" ; CPU=0 ; SEM_MODELOS=0 ; SEM_TESTE=0
for arg in "$@"; do
  case "$arg" in
    --com-chatterbox) COM_CB="sim" ;;
    --sem-chatterbox) COM_CB="nao" ;;
    --cpu) CPU=1 ;;
    --sem-modelos) SEM_MODELOS=1 ;;
    --sem-teste) SEM_TESTE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $arg (veja --help)" >&2; exit 2 ;;
  esac
done

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$RAIZ/.venv"
PY="$VENV/bin/python"
cd "$RAIZ" || exit 1
export PYTHONUTF8=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1 UV_LINK_MODE=copy

c_ciano=$'\e[36m'; c_verde=$'\e[32m'; c_amarelo=$'\e[33m'; c_vermelho=$'\e[31m'; c_fim=$'\e[0m'
[ -t 1 ] || { c_ciano=""; c_verde=""; c_amarelo=""; c_vermelho=""; c_fim=""; }
passo()  { printf '\n%s==> %s%s\n' "$c_ciano" "$1" "$c_fim"; }
ok()     { printf '    %s%s%s\n' "$c_verde" "$1" "$c_fim"; }
info()   { printf '    %s\n' "$1"; }
aviso()  { printf '    %s%s%s\n' "$c_amarelo" "$1" "$c_fim"; }
falha()  { printf '\n%sERRO: %s%s\n' "$c_vermelho" "$1" "$c_fim" >&2
           printf '%sVeja "Solução de problemas" em docs/SERVIDOR.md.%s\n' "$c_vermelho" "$c_fim" >&2
           exit 1; }

printf '%sLeitor de PDF com voz: instalação da voz neural local%s\n' "$c_ciano" "$c_fim"
echo "Pasta do projeto: $RAIZ"

# ----------------------------------------------------------------------------- uv
passo "Procurando o uv (gerenciador de pacotes Python)"
UV=()
if command -v uv >/dev/null 2>&1; then
  UV=(uv)
else
  for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1 && "$py" -m uv --version >/dev/null 2>&1; then UV=("$py" -m uv); break; fi
  done
  if [ ${#UV[@]} -eq 0 ] && [ -x "$HOME/.local/bin/uv" ]; then UV=("$HOME/.local/bin/uv"); fi
  if [ ${#UV[@]} -eq 0 ]; then
    for py in python3 python; do
      if command -v "$py" >/dev/null 2>&1; then
        info "Instalando o uv com: $py -m pip install --user uv"
        if "$py" -m pip install --user --quiet uv >/dev/null 2>&1 && "$py" -m uv --version >/dev/null 2>&1; then
          UV=("$py" -m uv); break
        fi
      fi
    done
  fi
  if [ ${#UV[@]} -eq 0 ]; then
    info "Baixando o uv pelo instalador oficial (astral.sh)…"
    if command -v curl >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh
    elif command -v wget >/dev/null 2>&1; then wget -qO- https://astral.sh/uv/install.sh | sh
    fi
    [ -x "$HOME/.local/bin/uv" ] && UV=("$HOME/.local/bin/uv")
  fi
fi
[ ${#UV[@]} -gt 0 ] || falha "não consegui instalar o uv. Instale manualmente (https://docs.astral.sh/uv/) e rode de novo."
uv_run() { "${UV[@]}" "$@" || falha "o comando 'uv $*' falhou."; }
ok "Usando $("${UV[@]}" --version)"

# ----------------------------------------------------------------------------- .venv
passo "Ambiente Python $PYTHON_VERSION (.venv)"
if [ -x "$PY" ] && [ "$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" = "$PYTHON_VERSION" ]; then
  ok "Já existe."
else
  if [ -e "$VENV" ]; then aviso "O .venv existente está incompleto ou usa outra versão; vou recriá-lo."; rm -rf "$VENV"; fi
  info "Criando o .venv (o uv baixa o Python $PYTHON_VERSION se precisar)…"
  uv_run venv "$VENV" --python "$PYTHON_VERSION"
  ok "Criado."
fi

# ----------------------------------------------------------------------------- GPU e PyTorch
passo "Placa de vídeo e PyTorch"
INDICE="cpu"
SO="$(uname -s)"
if [ "$CPU" = 1 ]; then
  info "Opção --cpu: usando o PyTorch de CPU."
elif [ "$SO" = "Darwin" ]; then
  INDICE="pypi"
  info "macOS: PyTorch padrão do PyPI (CPU). Não testado; veja docs/SERVIDOR.md."
elif command -v nvidia-smi >/dev/null 2>&1 && LINHA="$(nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader 2>/dev/null | head -n1)" && [ -n "$LINHA" ]; then
  IFS=',' read -r NOME CC DRV MEM <<<"$LINHA"
  NOME="$(echo "$NOME" | xargs)"; CC="$(echo "$CC" | xargs)"; DRV="$(echo "$DRV" | xargs)"; MEM="$(echo "$MEM" | xargs)"
  ok "GPU NVIDIA: $NOME ($MEM, driver $DRV, compute $CC)"
  CC_MAIOR="${CC%%.*}"; DRV_MAIOR="${DRV%%.*}"
  if [ "${CC_MAIOR:-0}" -ge 10 ] 2>/dev/null; then INDICE="cu128"
  elif [ "${CC_MAIOR:-0}" -ge 5 ] 2>/dev/null; then INDICE="cu126"
  else aviso "Placa antiga demais para o PyTorch atual; usando a CPU."; fi
  if [ "$INDICE" != "cpu" ] && [ "${DRV_MAIOR:-0}" -lt 525 ] 2>/dev/null; then
    aviso "Driver NVIDIA $DRV é antigo para CUDA 12. Atualize o driver; se a voz não usar a GPU, rode com --cpu."
  fi
else
  info "Nenhuma placa NVIDIA encontrada: usando o PyTorch de CPU (funciona, mas é mais lento)."
fi

TORCH_TENHO="$("$PY" -c 'import importlib.metadata as m; print(m.version("torch"))' 2>/dev/null || true)"
if [ "$INDICE" = "pypi" ]; then TORCH_QUERO="$TORCH_VERSION"; else TORCH_QUERO="$TORCH_VERSION+$INDICE"; fi
instalar_torch() {
  local extra=()
  [ -n "$TORCH_TENHO" ] && extra=(--reinstall-package torch --reinstall-package torchaudio)
  if [ "$INDICE" = "pypi" ]; then
    uv_run pip install --python "$PY" "torch==$TORCH_VERSION" "torchaudio==$TORCH_VERSION" ${extra[@]+"${extra[@]}"}
  else
    uv_run pip install --python "$PY" "torch==$TORCH_VERSION" "torchaudio==$TORCH_VERSION" \
      --index-url "https://download.pytorch.org/whl/$INDICE" ${extra[@]+"${extra[@]}"}
  fi
}
if [ "$TORCH_TENHO" = "$TORCH_QUERO" ]; then
  ok "PyTorch $TORCH_TENHO já instalado."
else
  if [ -n "$TORCH_TENHO" ]; then info "Trocando o PyTorch $TORCH_TENHO por $TORCH_QUERO…"
  else info "Instalando o PyTorch $TORCH_QUERO (download grande com CUDA)…"; fi
  instalar_torch
  ok "PyTorch $TORCH_QUERO instalado."
fi

# ----------------------------------------------------------------------------- Kokoro
passo "Servidor e motor Kokoro (requirements.txt)"
uv_run pip install --python "$PY" -r "$RAIZ/requirements.txt"
ok "Pronto."

# ----------------------------------------------------------------------------- Chatterbox
passo "Motor Chatterbox (opcional)"
CB_INSTALADO=0
"$PY" -c 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("chatterbox") else 1)' 2>/dev/null && CB_INSTALADO=1
QUER_CB=0
if [ "$COM_CB" = "sim" ]; then QUER_CB=1
elif [ "$COM_CB" = "nao" ]; then QUER_CB=0
elif [ "$CB_INSTALADO" = 1 ]; then QUER_CB=1; info "Já instalado; conferindo as dependências."
elif [ -t 0 ]; then
  echo "    O Chatterbox é uma voz mais expressiva (23 idiomas), porém mais lenta e pesada:"
  echo "    +3 GB de download e ~3,5 GB de memória de vídeo. O Kokoro continua disponível."
  read -r -p "    Instalar o Chatterbox também? [s/N] " RESP
  case "$(echo "$RESP" | tr '[:upper:]' '[:lower:]')" in s|sim|y|yes) QUER_CB=1 ;; esac
fi
if [ "$QUER_CB" = 1 ]; then
  uv_run pip install --python "$PY" -r "$RAIZ/requirements-chatterbox.txt"
  # --no-deps: o pacote fixa torch==2.6.0 e puxa o gradio (só das demos); ver requirements-chatterbox.txt
  uv_run pip install --python "$PY" --no-deps "$CHATTERBOX_PKG"
  ok "Chatterbox instalado."
elif [ "$COM_CB" = "nao" ] && [ "$CB_INSTALADO" = 1 ]; then
  uv_run pip uninstall --python "$PY" chatterbox-tts
  ok "Chatterbox removido (o Kokoro continua)."
else
  info "Pulado. Para instalar depois: scripts/instalar.sh --com-chatterbox"
fi

TORCH_FINAL="$("$PY" -c 'import importlib.metadata as m; print(m.version("torch"))' 2>/dev/null || true)"
if [ "$TORCH_FINAL" != "$TORCH_QUERO" ]; then
  aviso "O PyTorch mudou para $TORCH_FINAL durante a instalação; reinstalando $TORCH_QUERO…"
  TORCH_TENHO="$TORCH_FINAL"; instalar_torch
fi

# ----------------------------------------------------------------------------- modelos e teste
if [ "$SEM_MODELOS" = 0 ]; then
  passo "Baixando os modelos (ficam no cache do Hugging Face, ~/.cache/huggingface)"
  "$PY" -m servidor --baixar-modelos || falha "não consegui baixar os modelos. Confira a internet e rode de novo."
  if [ "$SEM_TESTE" = 0 ]; then
    passo "Teste rápido de voz"
    "$PY" -m servidor --testar || falha "o teste de voz falhou (mensagens acima)."
  fi
fi

printf '\n%sInstalação concluída!%s\n' "$c_verde" "$c_fim"
echo "  Para iniciar:  scripts/iniciar.sh   (ou: scripts/iniciar.sh --preload)"
echo "  Depois abra:   http://localhost:8090"
