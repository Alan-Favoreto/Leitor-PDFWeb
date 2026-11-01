# Leitor de PDF com voz: arquitetura e contratos

Página web estática (HTML + CSS + JS em módulos ES, sem build, sem npm). Abre um PDF do
computador, mostra as páginas e lê o texto em voz alta com a voz sintética do navegador
(Web Speech API), destacando a frase que está sendo lida.

- **PDF:** pdf.js `pdfjs-dist@4.10.38` via CDN jsDelivr (versão fixa).
  - `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs`
  - `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs`
- **Voz:** `window.speechSynthesis` (sem servidor, sem chave de API). Preferir vozes pt-BR.
- **Servir:** módulos ES não funcionam em `file://`. Servir a pasta `web/`: com a voz de IA,
  `python -m servidor` (tarefa "Servidor de voz", Ctrl+Shift+B); sem ela,
  `python -m http.server 8090 --directory web` (tarefa "Servidor estático (sem IA)").
  Abrir `http://localhost:8090`.

## Estrutura de pastas e dono de cada arquivo

> **Desde a versão 2** (seção "Voz neural local" no fim), o site fica em `web/`. Nos caminhos
> do resto deste documento, `index.html`, `css/` e `js/` ficam dentro de `web/`.

```
leitor-pdf-voz/
├── README.md                     [Interface]
├── .vscode/tasks.json            [Interface]  tarefas "Servidor de voz", "Servidor estático (sem IA)"...
├── .vscode/launch.json           [Interface]  abrir no Chrome/Edge depurando (webRoot = web/)
├── docs/ARQUITETURA.md           (este arquivo)
└── web/
    ├── index.html                [Interface]
    ├── css/
    │   ├── base.css              [Interface]  reset, tokens de cor (claro/escuro), tipografia
    │   ├── layout.css            [Interface]  cabeçalho, área do documento, barra do player
    │   ├── components.css        [Interface]  botões, sliders, painel de ajustes, toasts, drop zone
    │   └── pdf-viewer.css        [PDF]        páginas, camada de texto, destaques
    └── js/
        ├── main.js               [Interface]  ponto de entrada; liga PDF + Voz + UI
        ├── pdf/
        │   ├── pdfjs.js          [PDF]        importa pdf.js do CDN e configura o worker
        │   ├── pdf-document.js   [PDF]        openPdf(), PdfDoc
        │   ├── text-extractor.js [PDF]        texto da página → frases (com offsets)
        │   └── pdf-viewer.js     [PDF]        PdfViewer: rolagem contínua, lazy render, zoom, destaque
        ├── tts/
        │   ├── voices.js         [Voz]        listagem/ordenação de vozes, escolha da padrão
        │   ├── text-chunker.js   [Voz]        quebra frases longas em pedaços seguros
        │   ├── speech-engine.js  [Voz]        SpeechEngine: wrapper do speechSynthesis
        │   └── reading-session.js [Voz]       ReadingSession: lê frase a frase, página a página
        ├── ui/
        │   ├── toolbar.js        [Interface]  abrir arquivo, página atual/total, zoom, tema
        │   ├── player-bar.js     [Interface]  play/pausa, parar, anterior/próxima, legenda da frase
        │   ├── settings-panel.js [Interface]  voz, velocidade, tom, volume
        │   ├── file-drop.js      [Interface]  arrastar e soltar PDF / tela inicial
        │   └── toast.js          [Interface]  avisos e erros
        └── utils/
            ├── storage.js        [Interface]  localStorage com try/catch (ajustes + posição por PDF)
            └── dom.js            [Interface]  helpers pequenos ($, el(), debounce)
```

Cada agente só cria/edita os arquivos marcados com o seu nome. Se precisar de algo de outro
módulo, use apenas o contrato abaixo.

## Convenções

- ES2022, `import`/`export` com caminho relativo e extensão `.js`. Sem dependências além do pdf.js.
- Identificadores em inglês; **comentários e textos da interface em pt-BR**.
- 2 espaços, ponto e vírgula, aspas simples. JSDoc curto nas APIs públicas.
- Classes que emitem eventos estendem `EventTarget` e disparam `CustomEvent(nome, { detail })`.
- Erros para o usuário: `Error` com mensagem em pt-BR e, quando útil, uma propriedade `code`.
- Nada de `console.log` sobrando; `console.warn` só para problemas reais.

## Tipos compartilhados

```js
/** Texto de uma página, já normalizado (hifenização desfeita, espaços colapsados). */
PageText = {
  pageNumber: number,      // 1-based
  text: string,            // texto corrido da página
  sentences: Sentence[],   // em ordem de leitura; vazio se a página não tem texto
  isEmpty: boolean,        // true se não há texto legível (ex.: PDF escaneado)
}

Sentence = {
  id: string,              // `p${pageNumber}s${index}`, único no documento
  pageNumber: number,
  index: number,           // posição dentro da página (0-based)
  text: string,            // a frase pronta para falar
  start: number,           // offset inicial em PageText.text
  end: number,             // offset final (exclusivo) em PageText.text
}
```

## Módulo PDF (`js/pdf/`)

```js
// pdf-document.js
export async function openPdf(source /* File | ArrayBuffer */, { password } = {}) // → PdfDoc
// Erros com .code: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT' | 'INVALID_PDF'

PdfDoc = {
  numPages: number,
  title: string,           // metadado Title ou nome do arquivo sem extensão
  fingerprint: string,     // id estável do arquivo (para salvar a posição de leitura)
  getPageText(n): Promise<PageText>,   // com cache
  destroy(): Promise<void>,
  raw,                     // PDFDocumentProxy (uso interno do módulo PDF)
}

// pdf-viewer.js
export class PdfViewer extends EventTarget {
  constructor(containerEl)
  async open(pdfDoc)                     // monta placeholders de todas as páginas, renderiza sob demanda
  close()
  get currentPage()                      // página mais visível
  goToPage(n, { behavior = 'smooth' } = {})
  get zoom()                             // número (1 = 100%)
  setZoom(value /* number | 'fit-width' */)
  zoomIn(); zoomOut()
  highlightSentence(sentence | null, { scroll = true } = {}) // destaca a frase na camada de texto;
                                                              // rola só se estiver fora da tela
  highlightWord(sentence, charIndex, charLength)             // palavra atual (offsets relativos a sentence.text)
  // eventos:
  //   'pagechange'     { pageNumber }
  //   'zoomchange'     { zoom }
  //   'sentenceclick'  { sentence }   usuário tocou num trecho → começar a ler dali
}
```

Classes CSS dos destaques (definidas em `pdf-viewer.css`, usando os tokens abaixo):
`.hl-sentence` e `.hl-word`.

## Módulo Voz (`js/tts/`)

```js
// speech-engine.js
export class SpeechEngine extends EventTarget {
  static isSupported(): boolean
  async init()                            // espera as vozes carregarem (voiceschanged, com timeout)
  getVoices(): Voice[]                    // pt-BR primeiro, depois pt-*, depois o resto
  get voiceId(); setVoice(id)
  get rate(); set rate(v)                 // 0.5–2.5
  get pitch(); set pitch(v)               // 0–2
  get volume(); set volume(v)             // 0–1
  speak(text, { id } = {}): Promise<'end' | 'cancelled'>  // divide texto longo internamente
  pause(); resume(); cancel()
  get state()                             // 'idle' | 'speaking' | 'paused'
  // eventos: 'boundary' { id, charIndex, charLength }  (offsets relativos ao texto passado)
  //          'error'    { message }
}

Voice = { id /* voiceURI */, name, lang, localService: boolean, isDefault: boolean }

// reading-session.js
export class ReadingSession extends EventTarget {
  constructor({ engine, source })         // source = { numPages, getPageText(n) } (um PdfDoc serve)
  async start({ pageNumber = 1, sentenceIndex = 0 } = {})
  pause(); resume(); toggle(); stop()
  next(); previous()                      // pula frase (atravessa páginas)
  restartCurrent()                        // reinicia a frase atual (usado ao trocar voz/velocidade)
  get state()                             // 'idle' | 'loading' | 'playing' | 'paused' | 'finished'
  get position()                          // { pageNumber, sentenceIndex } | null
  // eventos:
  //   'statechange' { state }
  //   'sentence'    { sentence }                        começou a falar esta frase
  //   'word'        { sentence, charIndex, charLength } relativo a sentence.text
  //   'pagechange'  { pageNumber }
  //   'finished'    {}
  //   'error'       { message }
}
```

Regras da sessão: pula páginas vazias; pré-carrega o texto da próxima página enquanto lê;
trocar voz/velocidade/tom durante a leitura vale a partir da frase atual (a UI chama
`restartCurrent()`).

## Tokens de design (definidos em `css/base.css`)

```
--bg, --surface, --surface-2, --text, --text-muted, --border,
--accent, --accent-contrast, --danger,
--hl-sentence   (fundo da frase lida, translúcido)
--hl-word       (fundo da palavra atual, mais forte)
--page-shadow, --radius, --gap
```

Tema escuro via `@media (prefers-color-scheme: dark)` e `:root[data-theme="dark"|"light"]`.
A página do PDF continua branca no tema escuro (só a moldura muda).

## Fluxo em `main.js`

1. Usuário abre/solta um PDF → `openPdf(file)` → `viewer.open(doc)` → restaura posição salva.
2. Play → `session.start(posição atual ou página visível)`.
3. `session` `'sentence'` → `viewer.highlightSentence(s)` + legenda na barra + salvar posição.
4. `session` `'word'` → `viewer.highlightWord(...)`.
5. `viewer` `'sentenceclick'` → `session.start({ pageNumber, sentenceIndex })`.
6. Ajustes de voz → `engine` + `session.restartCurrent()` se estiver tocando; salvar em `storage`.
7. Atalhos: Espaço = play/pausa, ←/→ = frase anterior/próxima, Esc = parar, +/- = zoom.

---

# Versão 2: voz neural local (GPU do usuário)

Objetivo: voz humana gerada por um modelo de IA rodando na placa de vídeo de quem usa o
leitor, com detecção automática de idioma. O projeto será publicado (GitHub) para outras
pessoas rodarem nas próprias máquinas: instalação simples, sem caminhos fixos deste PC,
funciona em Windows (principal) e Linux, com GPU NVIDIA ou, mais devagar, só CPU.
Os modelos precisam ter licença que permita redistribuir o projeto (Apache/MIT).

## Estrutura nova

```
leitor-pdf-voz/
├── web/                          o site (antes ficava na raiz)
│   ├── index.html, css/, js/     (mesmos donos da versão 1)
│   └── js/tts/
│       ├── neural-engine.js      [Voz Web]   NeuralSpeechEngine (fala pelo servidor)
│       ├── lang-detect.js        [Voz Web]   detecção de idioma
│       └── reading-session.js    [Voz Web]   (alterado: idioma + pré-carregamento)
├── servidor/                     [Servidor]  pacote Python: `python -m servidor`
│   ├── __main__.py               argumentos (--host, --port, --engine, --device, --preload)
│   ├── app.py                    aiohttp: API + arquivos estáticos de web/
│   ├── config.py                 padrões + servidor/config.json opcional (gitignored)
│   ├── audio_cache.py            LRU em memória dos áudios gerados
│   └── engines/
│       ├── base.py               interface TTSEngine
│       ├── kokoro_engine.py      Kokoro-82M (Apache-2.0)
│       └── chatterbox_engine.py  Chatterbox Multilingual (MIT), opcional
├── scripts/                      [Servidor]  instalar.ps1 / iniciar.ps1 (+ .bat que chamam
│                                             os .ps1) e instalar.sh / iniciar.sh
├── requirements.txt              [Servidor]
├── requirements-chatterbox.txt   [Servidor]  extra opcional
├── .venv/                        (gerado pela instalação, gitignored)
├── .gitignore                    [Interface]
├── .vscode/                      [Interface]
├── README.md                     [Interface]
└── docs/ARQUITETURA.md, docs/SERVIDOR.md [Servidor escreve SERVIDOR.md]
```

O servidor serve **somente** a pasta `web/` (nunca a raiz do projeto, `.venv`, `servidor/`).
Escuta em `127.0.0.1:8090` por padrão; `--host 0.0.0.0` é opção explícita para usar na rede.
O site continua funcionando aberto por qualquer servidor estático: sem a API, usa as vozes do
navegador (versão 1).

## API HTTP do servidor (mesma origem do site, sem CORS)

```
GET  /api/tts/status
  200 { ok: true, version: "2.0.0", device: "cuda" | "cpu", gpu: "NVIDIA GeForce RTX 3060" | null,
        defaultEngine: "kokoro",
        engines: [{ id: "kokoro", name: "Kokoro (rápido)", available: true, loaded: false,
                    languages: ["pt","en","es","fr","it","hi","ja","zh"], error: null }] }
  available=false + error (pt-BR) quando a dependência/modelo não está instalado.

GET  /api/tts/voices
  200 { voices: [{ id: "kokoro:pf_dora", engine: "kokoro", name: "Dora", gender: "f",
                   languages: ["pt"], default: true }] }
  Vozes multilíngues (Chatterbox) listam vários idiomas em `languages`.

POST /api/tts      Content-Type: application/json
  { text: string (1..600 chars), lang: "pt" | "en" | ..., voice?: string, engine?: string }
  200 audio/wav (PCM 16-bit mono). Cabeçalhos: X-Audio-Duration (segundos, float),
      X-Engine, X-Voice, X-Cache: hit|miss.
  Erros: JSON { error: "mensagem em pt-BR", code } com 400 (entrada inválida),
         422 (idioma/voz não suportados por esse motor), 503 (motor indisponível/carregando falhou).
  Sem `voice` (ou voz que não fala `lang`): o servidor escolhe a voz padrão daquele idioma.

POST /api/tts/unload   libera a VRAM (descarrega os modelos). 200 { ok: true }
```

Regras do servidor:
- Modelos carregam sob demanda no primeiro pedido (`--preload` carrega na partida) e são
  descarregados após `idle_unload_minutes` (padrão 10) sem uso, para devolver a VRAM a outros
  programas (ex.: ComfyUI). Uma fila única por GPU (um pedido gerando por vez).
- Cache LRU de áudio por (engine, voz, idioma, texto).
- Validação: texto obrigatório e limitado, `lang`/`voice`/`engine` só de listas conhecidas,
  JSON com tamanho máximo. Nunca devolver traceback ao navegador (log no terminal).
- Bloqueio de DNS rebinding: aceitar só `Host` localhost/127.0.0.1/IP da máquina quando
  em 0.0.0.0. POST só com `Origin` igual ao host (ou ausente).
- Velocidade NÃO é feita no servidor: o navegador usa `playbackRate` (mantém o tom).

## Contrato JS novo

```js
// lang-detect.js
export function detectLanguage(text, { fallback = null } = {}) // → { lang: 'pt'|'en'|'es'|'fr'|'it'|'de'|..., confidence: 0..1 } | null
// Heurística sem dependências: palavras funcionais + acentos/letras típicas. Distinguir bem
// pt × es (o par mais difícil). null quando o texto é curto/ambíguo demais.

// neural-engine.js — mesma interface pública de SpeechEngine (ver acima), mais:
export class NeuralSpeechEngine extends EventTarget {
  constructor({ baseUrl = '' } = {})
  static async probe(baseUrl = ''): Promise<Status | null>  // GET /api/tts/status com timeout curto
  get kind()            // 'neural'  (SpeechEngine ganha `get kind() { return 'browser' }`)
  get supportsPitch()   // false     (SpeechEngine: true)
  speak(text, { id, lang } = {})       // busca o áudio (ou usa o pré-carregado) e toca
  prefetch(text, { lang } = {})        // gera e guarda em cache local, sem tocar
  // voz: o usuário escolhe uma voz; se ela não fala `lang`, usa a voz padrão daquele idioma.
  // 'boundary' é estimado pelo progresso do áudio (peso por número de letras de cada palavra).
  // pause/resume são instantâneos (HTMLAudioElement ou Web Audio).
}

// SpeechEngine (navegador) também passa a aceitar speak(text, { id, lang }) e, se `lang` for
// dado, escolhe a melhor voz do navegador para aquele idioma quando a voz escolhida não o fala.

// ReadingSession (alterado):
//  - detecta o idioma de cada página (`detectLanguage(page.text)`, com o idioma anterior/do
//    documento como fallback) e passa `lang` em cada `engine.speak`;
//  - frases longas com idioma claramente diferente da página usam o próprio idioma;
//  - chama `engine.prefetch?.(texto, { lang })` das próximas 2 frases enquanto fala a atual
//    (atravessando página), para não haver silêncio entre frases;
//  - novo evento 'langchange' { lang } quando o idioma da leitura muda.
```

Interface: no painel de ajustes, escolha do motor ("Voz de IA (neste computador)" /
"Voz do navegador"), estado do servidor (pronto, carregando modelo, indisponível + motivo),
lista de vozes do motor escolhido agrupada por idioma, "Idioma: automático" ou fixo, aviso do
idioma detectado. Tom some quando `supportsPitch` é false. Trocar de motor durante a leitura
recria a sessão na mesma posição.
