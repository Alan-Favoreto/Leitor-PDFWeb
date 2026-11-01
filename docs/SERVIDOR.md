# Servidor de voz neural local

O servidor (`python -m servidor`) faz duas coisas:

1. serve o site da pasta `web/` (e só ela) em `http://localhost:8090`;
2. oferece a API `/api/tts…`, que gera a fala com um modelo de IA na sua placa de vídeo
   (ou na CPU, mais devagar).

Tudo roda no seu computador. A internet só é usada na instalação e no primeiro uso,
para baixar pacotes (PyPI, PyTorch, GitHub) e modelos (Hugging Face). Nenhum texto do PDF sai
da máquina.

Sem o servidor, o site continua funcionando com as vozes do navegador (versão 1).

## Requisitos

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Windows 10/11 ou Linux x86-64 | Windows 11 |
| Placa de vídeo | nenhuma (usa a CPU) | NVIDIA com 4 GB+ de VRAM (Kokoro) ou 6 GB+ (Chatterbox) |
| Driver NVIDIA | 528+ (Windows) / 525+ (Linux) | o mais recente |
| Disco | ~8 GB (ambiente) + 0,4 GB (Kokoro) | +3,1 GB para o Chatterbox |
| Python | não precisa: o instalador baixa o Python 3.11 com o `uv` | |

macOS não é testado. O instalador `.sh` instala o PyTorch de CPU, e o servidor deve rodar,
mas sem aceleração.

## Instalação

### Windows

Na pasta do projeto, dê dois cliques em `scripts\instalar.bat` ou rode no terminal:

```bat
scripts\instalar.bat                  :: pergunta se quer o Chatterbox
scripts\instalar.bat -ComChatterbox   :: instala também o Chatterbox
scripts\instalar.bat -SemChatterbox   :: só o Kokoro (remove o Chatterbox, se existir)
scripts\instalar.bat -Cpu             :: força o PyTorch de CPU
scripts\instalar.bat -SemModelos      :: não baixa os modelos agora (baixam no 1º uso)
scripts\instalar.bat -SemTeste        :: pula o teste de voz no final
```

### Linux

```bash
scripts/instalar.sh                   # pergunta se quer o Chatterbox
scripts/instalar.sh --com-chatterbox
scripts/instalar.sh --sem-chatterbox
scripts/instalar.sh --cpu
scripts/instalar.sh --sem-modelos
scripts/instalar.sh --sem-teste
```

### O que o instalador faz

Pode rodar de novo quando quiser: ele só faz o que falta.

1. Acha o [uv](https://docs.astral.sh/uv/). Se não existir, instala com
   `python -m pip install --user uv`. Sem nenhum Python na máquina, usa o instalador oficial
   da Astral.
2. Cria `.venv` com **Python 3.11** (o uv baixa o Python sozinho). Se o `.venv` existir com
   outra versão, recria.
3. Lê a placa no `nvidia-smi` e instala `torch==2.8.0` e `torchaudio==2.8.0` do índice
   oficial do PyTorch:
   - `cu126` para NVIDIA até a série RTX 40;
   - `cu128` para RTX 50 (Blackwell, compute 10+);
   - `cpu` quando não há NVIDIA.

   Se você trocar de placa, ele troca o PyTorch.
4. `requirements.txt`: aiohttp, Kokoro, misaki e o modelo do spaCy para inglês.
5. Se pedido, `requirements-chatterbox.txt` e o pacote `chatterbox-tts` com `--no-deps`
   (motivo abaixo).
6. `python -m servidor --baixar-modelos`, depois `python -m servidor --testar`: gera uma frase
   em pt, en e es em cada motor e mostra os tempos.

### Instalação manual (sem os scripts)

```bash
uv venv .venv --python 3.11
uv pip install --python .venv torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126
uv pip install --python .venv -r requirements.txt
# opcional:
uv pip install --python .venv -r requirements-chatterbox.txt
uv pip install --python .venv --no-deps "chatterbox-tts @ https://github.com/resemble-ai/chatterbox/archive/5de7a54aa4e5e2baadb0182dde554908b48b85c2.zip"
```

## Iniciar

```bat
scripts\iniciar.bat                 :: Windows
scripts\iniciar.bat --preload       :: já carrega o modelo ao abrir
```

```bash
scripts/iniciar.sh                  # Linux
```

Depois abra `http://localhost:8090`. Os scripts ativam o `.venv` e rodam
`python -m servidor`, repassando os argumentos. Para parar, use `Ctrl+C`.

### Argumentos

| Argumento | Padrão | O que faz |
|---|---|---|
| `--host` | `127.0.0.1` | Endereço de escuta. `0.0.0.0` abre para a rede local (só com este argumento explícito). |
| `--port` | `8090` | Porta. |
| `--engine kokoro\|chatterbox` | `kokoro` | Motor padrão, usado quando o pedido não diz qual. |
| `--device auto\|cuda\|cpu` | `auto` | Onde o modelo roda. `auto` usa a GPU NVIDIA se houver. |
| `--preload` | desligado | Carrega o motor padrão na partida, em segundo plano. |
| `--idle-unload-minutes N` | `10` | Descarrega o modelo após N minutos sem uso. `0` = nunca. |
| `--abrir` | | Abre o navegador quando o servidor fica pronto. |
| `--baixar-modelos` | | Só baixa os modelos dos motores instalados e sai. |
| `--testar [--saida PASTA]` | | Gera frases de teste, mostra tempo e VRAM e sai. Com `--saida`, salva os WAVs. |
| `-v`, `--verbose` | | Mensagens de depuração e das bibliotecas. |

### `servidor/config.json` (opcional, não versionado)

Os argumentos têm prioridade sobre o arquivo. Chaves que começam com `_` são comentários.
Exemplo:

```json
{
  "default_engine": "kokoro",
  "idle_unload_minutes": 10,
  "cache_mb": 128,
  "max_text_chars": 600,
  "max_queue": 24,
  "allowed_hosts": ["meupc.local"],
  "kokoro": { "speed": 1.0 },
  "chatterbox": { "model": "v3", "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8 }
}
```

- `kokoro.revision` e `chatterbox.revision` fixam o commit dos modelos no Hugging Face, para
  a instalação ser reproduzível. `""` usa sempre a versão mais nova.
- `chatterbox.model`: `v3` (padrão, mais estável) ou `v2`.
- `chatterbox.exaggeration`: mais alto deixa a fala mais emotiva e rápida.
- `chatterbox.cfg_weight`: mais baixo deixa a fala mais lenta e solta.

## API (mesma origem do site, sem CORS)

Todas as respostas de erro são JSON `{ "error": "mensagem em pt-BR", "code": "CODIGO" }`.
Nunca vai traceback para o navegador; o detalhe fica no terminal.

### `GET /api/tts/status`

```json
{
  "ok": true, "version": "2.0.0", "device": "cuda", "gpu": "NVIDIA GeForce RTX 3060",
  "defaultEngine": "kokoro",
  "engines": [
    { "id": "kokoro", "name": "Kokoro (rápido)", "available": true, "loaded": false,
      "loading": false, "languages": ["pt","en","es","fr","it","hi","zh"], "error": null },
    { "id": "chatterbox", "name": "Chatterbox (expressivo)", "available": true, "loaded": false,
      "loading": false, "languages": ["ar","da","de","el","en","es","fi","fr","he","hi","it",
      "ja","ko","ms","nl","no","pl","pt","ru","sv","sw","tr","zh"], "error": null }
  ],
  "maxTextLength": 600, "idleUnloadMinutes": 10, "queue": 0,
  "cache": { "items": 0, "bytes": 0, "maxBytes": 134217728, "hits": 0, "misses": 0 },
  "vram": { "allocatedMB": 0, "reservedMB": 0, "totalMB": 12288 }
}
```

- `available:false` vem com `error` (pt-BR) quando o motor não está instalado.
- Com `available:true`, `error` guarda a última falha de carga (ex.: falta de VRAM) e volta a
  `null` quando carrega.
- `loading:true` enquanto o modelo carrega.
- Os campos `loading`, `maxTextLength`, `idleUnloadMinutes`, `queue`, `cache` e `vram` são
  extras do contrato. `vram` só aparece com CUDA.
- O japonês só aparece no Kokoro se o `misaki[ja]` (pyopenjtalk) estiver instalado. Ele não
  vem por padrão porque exige compilador no Windows; o Chatterbox fala japonês.

### `GET /api/tts/voices[?engine=kokoro]`

```json
{ "voices": [
  { "id": "kokoro:pf_dora", "engine": "kokoro", "name": "Dora", "gender": "f",
    "languages": ["pt"], "default": true, "defaultFor": ["pt"] },
  { "id": "chatterbox:padrao", "engine": "chatterbox", "name": "Padrão (multilíngue)",
    "gender": "f", "languages": ["ar","…","zh"], "default": true, "defaultFor": ["ar","…","zh"],
    "description": "Voz embutida do modelo; fala todos os idiomas." }
] }
```

- Lista só os motores disponíveis.
- `default` é `true` quando a voz é a padrão de pelo menos um idioma. `defaultFor` diz de quais.
- Vozes clonadas do Chatterbox têm `gender: null`.

### `POST /api/tts`

Corpo, com `Content-Type: application/json` obrigatório e até 16 KB:

```json
{ "text": "Olá, mundo.", "lang": "pt", "voice": "kokoro:pf_dora", "engine": "kokoro" }
```

- `text`: obrigatório.
  - Espaços e caracteres de controle são normalizados.
  - O limite é de 1 a 600 caracteres depois da limpeza.
  - Texto só com pontuação devolve 0,25 s de silêncio (200), para a leitura seguir.
- `lang`: obrigatório. Aceita `pt`, `pt-BR` e `pt_br`; todos viram `pt`.
- `voice`: opcional.
  - Precisa ser um id da lista de vozes.
  - Se a voz não fala `lang`, ou é de outro motor, usa a voz padrão do idioma.
  - O cabeçalho `X-Voice` diz qual voz foi usada.
- `engine`: opcional. Sem ele, vale o prefixo de `voice`; sem os dois, o motor padrão.

Resposta 200: `audio/wav`, PCM 16-bit mono, 24 kHz nos dois motores. Cabeçalhos:

| Cabeçalho | Exemplo |
|---|---|
| `X-Audio-Duration` | `8.360` (segundos) |
| `X-Engine` | `kokoro` |
| `X-Voice` | `kokoro:pf_dora` |
| `X-Lang` | `pt` |
| `X-Cache` | `hit` ou `miss` |

O áudio vem com o silêncio das pontas cortado (sobram ~50 ms no início e ~120 ms no fim) e
volume normalizado de leve.

Erros:

| Status | `code` | Quando |
|---|---|---|
| 400 | `TEXT_REQUIRED`, `TEXT_TOO_LONG`, `LANG_REQUIRED`, `LANG_INVALID`, `ENGINE_UNKNOWN`, `VOICE_INVALID`, `ENGINE_INVALID`, `BAD_JSON` | entrada inválida |
| 403 | `FORBIDDEN_HOST`, `FORBIDDEN_ORIGIN` | Host ou Origin não permitidos |
| 413 | `PAYLOAD_TOO_LARGE` | corpo acima de 16 KB |
| 415 | `BAD_CONTENT_TYPE` | corpo sem `application/json` |
| 422 | `LANG_UNSUPPORTED`, `VOICE_UNKNOWN`, `VOICE_FILE_INVALID` | idioma ou voz que esse motor não tem |
| 500 | `GENERATION_FAILED`, `INTERNAL` | falha inesperada (detalhe no terminal) |
| 503 | `ENGINE_UNAVAILABLE`, `LOAD_FAILED`, `GPU_OUT_OF_MEMORY`, `QUEUE_FULL`, `CANCELLED` | motor indisponível, sem VRAM ou fila cheia |

Como o servidor trata os pedidos:

- **Fila:** há uma fila única na GPU, e só um pedido gera por vez.
- **Pedidos repetidos:** dois pedidos iguais ao mesmo tempo (ex.: o `prefetch` e o `speak` da
  mesma frase) compartilham a mesma geração.
- **Desistência:** se o navegador desiste do pedido antes de ele chegar à GPU (fecha a
  conexão, ou `AbortController` no `fetch`), o pedido é descartado. Assim, pular frases não
  enche a fila.
- **Cache:** guarda até 128 MB de áudio em memória (LRU), com chave (motor, voz, idioma, texto).

### `POST /api/tts/unload`

Corpo opcional `{ "engine": "kokoro" }`; sem corpo, descarrega todos os motores. Espera a
geração em andamento terminar.

Resposta: `{ "ok": true, "unloaded": ["kokoro"] }`.

### Segurança

- **Escuta:** só em `127.0.0.1`, a não ser que você passe `--host`.
- **DNS rebinding:** só aceita `Host` igual a `localhost`, `127.0.0.1` ou `::1`. Com
  `--host 0.0.0.0`, aceita também os IPs e o nome desta máquina, mais o que estiver em
  `allowed_hosts`.
- **CSRF:** `POST` só passa sem `Origin` ou com `Origin` igual ao `Host`. Pedidos com
  `Sec-Fetch-Site: cross-site` são recusados, e o corpo precisa ser `application/json`.
- **Arquivos:** só serve `web/`. Caminhos com `..`, arquivos ocultos (`.algo`) e qualquer
  coisa fora de `web/` dão 404.

## Motores e licenças

| Motor | Modelo | Licença | Idiomas | VRAM | Velocidade (RTX 3060) |
|---|---|---|---|---|---|
| **Kokoro** (padrão) | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) v1.0, 82 M parâmetros | Apache-2.0 | pt, en, es, fr, it, hi, zh (+ja com `misaki[ja]`) | ~0,7 GB | ~25× tempo real |
| **Chatterbox** (opcional) | [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox) Multilingual **V3**, 500 M parâmetros | MIT | 23 idiomas, inclusive pt | ~3,5 GB | ~0,8× tempo real (mais lento que a fala) |

### Kokoro

- **Vozes:**
  - pt: `pf_dora` (padrão), `pm_alex`, `pm_santa`
  - es: `ef_dora`, `em_alex`, `em_santa`
  - en: `af_heart` (padrão) e mais 12 (EUA e Reino Unido)
  - fr: `ff_siwis`
  - it: `if_sara`, `im_nicola`
  - hi: `hf_*`, `hm_*`
  - zh: `zf_*`, `zm_*`
- **G2P (texto → fonemas):** feito pelo [misaki](https://github.com/hexgrad/misaki)
  (Apache-2.0). Fora do inglês e do chinês, usa o **espeak-ng**.
- **espeak-ng:** vem pronto no pacote `espeakng-loader`, para Windows e Linux. Não é preciso
  instalar nada à mão.
  - Licença GPL-3.0. Ele é instalado como dependência e não faz parte do código deste projeto.
- **Português:** o espeak lê como pt-BR. Números e siglas saem por extenso no estilo do espeak
  (ex.: "15h30" vira "quinze agá trinta").

### Chatterbox

- **Versão:** instalado do GitHub no commit `5de7a54` (21/07/2026). O pacote 0.1.7 do PyPI
  ainda não tem o modelo V3.
- **Por que `--no-deps`:** o `pyproject` dele fixa `torch==2.6.0`, o que trocaria o PyTorch
  CUDA, e puxa o `gradio`, que só serve para as demos. O
  [Space oficial pt-BR](https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-pt-br)
  roda com torch 2.8.0, a mesma versão usada aqui.
- **`setuptools<81`:** fixado porque a marca d'água (`resemble-perth`) ainda importa
  `pkg_resources`.
- **Marca d'água:** o áudio sai com a marca inaudível *Perth* da Resemble AI, que faz parte do
  pacote.
- **Voz padrão:** a voz embutida (`conds.pt`), uma voz feminina em inglês que fala todos os
  idiomas. Em português o resultado é bem inteligível; o sotaque pode puxar um pouco para a
  voz de referência.
- **Vozes próprias:**
  1. Ponha um áudio limpo de 7 a 20 s (WAV, FLAC, MP3 ou OGG) em `servidor/vozes/`. O nome do
     arquivo vira a voz `chatterbox:<nome>`.
  2. Para soar nativo, use uma referência falada no idioma que vai ler.
  3. A pasta é lida a cada listagem; não precisa reiniciar.
  4. Use só vozes que você tem o direito de usar.
- **Semente:** a geração usa uma semente fixa por texto, então a mesma frase sai igual.

## Desempenho medido (esta máquina)

RTX 3060 12 GB (driver 596, ~4 GB já ocupados por outros programas), Ryzen 5 5600, 16 GB de
RAM, Windows 11, torch 2.8.0+cu126. Frase de teste de ~140 a 150 caracteres. Os tempos foram
medidos pela API HTTP.

| | Kokoro | Chatterbox V3 |
|---|---|---|
| Carga do modelo (1º pedido, com imports) | 8 a 12 s | 18 a 26 s |
| Recarga depois de descarregar (mesmo processo) | ~1,5 s | não medido (menos que a 1ª carga) |
| pt, 141 caracteres → 8,4 s de áudio (Kokoro) / 7,1 s (Chatterbox) | **0,30 a 0,37 s** | 8,4 a 9,6 s |
| es, 150 caracteres | 0,30 s | 8,8 s |
| en, 140 caracteres | 0,25 s (1,3 s no 1º pedido em inglês: carrega o spaCy) | 7,5 a 8,5 s |
| Fator tempo real (geração ÷ duração) | **~0,04** (~25× mais rápido que a fala) | **~1,2 a 1,35** |
| VRAM do processo (`nvidia-smi`) | +~1,0 GB (modelo ~0,5 GB + contexto CUDA) | +~3,6 GB (pico do PyTorch 3,2 GB) |
| Depois do `unload` | volta a ~+0,25 GB (o contexto CUDA fica até fechar o servidor) | idem |

- **Chatterbox é mais lento que a fala nesta placa.** O gargalo é o laço token a token do
  modelo (CPU e lançamento de kernels; `cProfile` confirma), não a VRAM. `autocast` fp16/bf16
  deixou mais lento (1,6 contra 1,2).
  - Na leitura contínua podem surgir pausas entre frases, mesmo com o pré-carregamento.
  - Para leitura longa, prefira o Kokoro.
- **Descarga:** depois de 10 min sem uso (configurável), os modelos são descarregados e a VRAM
  volta para outros programas (ex.: ComfyUI).
- **Pouca VRAM:** se faltar memória para carregar um motor e o outro estiver carregado, o
  servidor descarrega o outro e tenta de novo.

## Espaço em disco

| O quê | Onde | Tamanho |
|---|---|---|
| `.venv` (torch CUDA ~6,2 GB + Kokoro + Chatterbox) | pasta do projeto | ~7,2 GB |
| Modelo Kokoro + vozes | `~/.cache/huggingface/hub` | ~0,33 GB |
| Modelo Chatterbox V3 | `~/.cache/huggingface/hub` | ~3,0 GB |
| Segmentador de chinês do Chatterbox | `~/.pkuseg` | ~0,09 GB |
| Python 3.11 do uv | `%APPDATA%\uv\python` | ~0,08 GB |
| Cache de downloads do uv | `%LOCALAPPDATA%\uv\cache` | ~7 GB; pode apagar com `uv cache clean` |

Para mover o cache de modelos, defina `HF_HOME` antes de instalar ou iniciar.

## Solução de problemas

- **"A voz neural ainda não foi instalada"**: rode `scripts\instalar.bat`.
- **`device: "cpu"` mesmo com NVIDIA**: o PyTorch instalado é o de CPU, ou o driver é antigo.
  1. Atualize o driver.
  2. Rode `scripts\instalar.bat` de novo; ele troca o PyTorch para o CUDA.
  3. Confira com `.venv\Scripts\python -c "import torch; print(torch.cuda.is_available())"`.
- **`GPU_OUT_OF_MEMORY`**:
  - Feche programas que usam a GPU (ComfyUI, jogos) ou chame `POST /api/tts/unload`.
  - Para o Kokoro, `--device cpu` também é rápido o bastante.
- **"Não consegui abrir a porta 8090"**: outro programa usa a porta (talvez o
  `python -m http.server` da versão 1). Feche-o ou use `--port 8091`.
- **Chatterbox "não instalado"**: rode `scripts\instalar.bat -ComChatterbox`.
- **Primeiro uso sem internet**: os modelos baixam no primeiro uso. Rode o instalador com
  internet (sem `-SemModelos`). Depois funciona offline: o servidor usa o cache local antes de
  tentar a rede.
- **Erro do uv "Missing expected target directory for Python minor version link"**: apague o
  atalho `%APPDATA%\uv\python\cpython-3.11-windows-x86_64-none` e rode o instalador de novo.
- **Firewall do Windows perguntando**: só acontece com `--host 0.0.0.0`. O padrão
  (`127.0.0.1`) não abre nada para a rede.
- **Ver o erro completo**: rode `scripts\iniciar.bat -v`.
