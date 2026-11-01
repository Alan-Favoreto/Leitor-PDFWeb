# Leitor de PDF com Voz

Abra um PDF e ouça o texto lido em voz alta, com a frase (e a palavra) que está sendo lida
destacada na página. A voz pode ser **gerada por IA na sua própria placa de vídeo**, com som
bem mais humano, ou a voz sintética do navegador, que funciona sem instalar nada.

<!-- TODO: trocar por um GIF ou print do leitor funcionando, ex.: docs/demo.gif -->
<p align="center"><em>(espaço para um GIF ou print do leitor)</em></p>

- Abre PDF pelo botão ou arrastando o arquivo para a janela.
- Lê frase por frase, atravessando as páginas; toque num trecho do PDF para ler a partir dele.
- **Voz de IA local** (Kokoro, opcionalmente Chatterbox): roda no seu computador, sem conta,
  sem chave de API e sem mandar nada para a internet.
- **Detecta o idioma** de cada página e troca de voz sozinho (português, inglês, espanhol...).
- Velocidade e volume ajustáveis; com a voz do navegador, também o tom.
- Lembra onde você parou em cada PDF (até 50 arquivos) e continua dali.
- Tema claro e escuro; funciona no celular (a partir de 360 px de largura).

## Requisitos

| | |
|---|---|
| Sistema | Windows 10/11 (principal) ou Linux |
| Python | Não precisa ter instalado: o instalador usa o [uv](https://docs.astral.sh/uv/), que baixa o Python certo só para este projeto. Se já tiver Python, tudo bem também. |
| Placa de vídeo | NVIDIA **recomendada** (com driver atualizado). Sem ela, funciona só com o processador (CPU), mas cada frase demora mais para ficar pronta. |
| Disco | Cerca de **4 GB** para a voz de IA padrão (Kokoro), a maior parte é o PyTorch com suporte à placa de vídeo. O Chatterbox, opcional, pede uns **4 GB a mais**. Valores aproximados. |
| Navegador | Edge, Chrome ou Firefox atualizados |
| Internet | Só na instalação (baixar as bibliotecas e os modelos) e na primeira abertura do site (baixar o pdf.js). Depois, a leitura funciona sem internet. |

## Instalação em 3 passos

1. **Instalar** (só na primeira vez): dê dois cliques em `scripts\instalar.bat`.
   No Linux: `bash scripts/instalar.sh`. Ele cria a pasta `.venv` dentro do projeto e baixa
   o que a voz de IA precisa. Pode demorar alguns minutos.
2. **Ligar**: dê dois cliques em `scripts\iniciar.bat` (no Linux: `bash scripts/iniciar.sh`).
   Deixe a janela aberta enquanto usa o leitor; para desligar, feche a janela ou aperte `Ctrl+C`.
3. **Abrir** no navegador: **http://localhost:8090**

> Abrir o `web/index.html` com dois cliques (endereço `file://`) **não funciona**: o navegador
> bloqueia os módulos JavaScript fora de um servidor.

### Pelo VS Code

Abra a pasta do projeto no VS Code.

| Ação | Como |
|---|---|
| Instalar dependências | Terminal > Run Task > **Instalar dependências** |
| Ligar a voz de IA e o site | **Ctrl+Shift+B** (tarefa **Servidor de voz**) |
| Só o site, sem IA | Terminal > Run Task > **Servidor estático (sem IA)** (precisa de Python instalado) |
| Abrir no navegador | Terminal > Run Task > **Abrir no navegador** |
| Depurar | **F5** e escolha "Abrir no Edge (depurar)" ou "Abrir no Chrome (depurar)" |
| Parar | Lixeira no terminal da tarefa |

As duas tarefas de servidor usam a porta 8090: deixe só uma ligada por vez.

## Como usar

1. Toque em **Escolher PDF** (ou no ícone de pasta no cabeçalho) ou arraste o arquivo para a janela.
2. Toque em **▶** para ouvir. Ele continua de onde você parou ou começa na página que está na tela.
3. Toque em qualquer trecho do PDF para ler a partir dali.
4. No ícone de ajustes (canto superior direito):
   - **Motor de voz:** "Voz de IA (neste computador)" ou "Voz do navegador". O painel mostra
     se a voz de IA está pronta, carregando ou desligada, e se ela está usando a placa de vídeo
     ou o processador. Dá para trocar no meio da leitura: ela continua da mesma frase.
   - **Voz:** as vozes aparecem agrupadas por idioma; as que falam vários idiomas ficam em
     "Multilíngue".
   - **Idioma da leitura:** "Automático" descobre o idioma pelo texto de cada página e mostra
     "Detectado: Português" (e um selo "PT" na barra de baixo). Escolha um idioma fixo se a
     detecção errar.
   - **Velocidade, tom e volume.** O tom só aparece com a voz do navegador.
   - **Testar voz** fala uma frase curta com o motor e o idioma atuais.

Na **primeira frase** com a voz de IA, o modelo é carregado na placa de vídeo: aparece
"Carregando voz de IA…" na barra de baixo e pode levar de 10 a 30 segundos. Depois as frases
seguem sem pausa, porque as próximas já são preparadas enquanto a atual é lida. Depois de um
tempo sem uso (10 minutos, por padrão), o servidor libera a memória da placa de vídeo para
outros programas.

Se o servidor de voz não estiver ligado, o leitor usa a voz do navegador e avisa como ligar a
voz de IA. Depois de ligar, toque em **Verificar de novo** nos ajustes.

### Atalhos de teclado

| Tecla | O que faz |
|---|---|
| Espaço | Ler / pausar |
| ← / → | Frase anterior / próxima |
| Esc | Parar (ou fechar os ajustes) |
| + / − | Aumentar / diminuir o zoom |

No campo de página do cabeçalho, digite o número e aperte Enter para pular.

## Motores de voz e licenças

| Motor | O que é | Licença |
|---|---|---|
| **Kokoro** (padrão) | Modelo pequeno (82 milhões de parâmetros) e rápido. Fala português do Brasil, inglês, espanhol, francês, italiano, hindi, japonês e chinês. | Apache-2.0 |
| **Chatterbox Multilingual** (opcional) | Mais expressivo e mais pesado; precisa de mais memória de vídeo e é mais lento. Instalação extra, veja [`docs/SERVIDOR.md`](docs/SERVIDOR.md). | MIT |
| **Voz do navegador** | Web Speech API: as vozes que o navegador e o sistema já têm. | do navegador/sistema |
| **pdf.js** (Mozilla) | Mostra o PDF e extrai o texto. Carregado do CDN jsDelivr. | Apache-2.0 |

Os modelos são baixados pelo instalador direto das fontes oficiais; eles não fazem parte deste
repositório. Algumas bibliotecas instaladas junto podem ter licenças próprias (por exemplo, o
Kokoro pode usar o espeak-ng, GPL-3.0, para pronunciar alguns idiomas); confira em
[`docs/SERVIDOR.md`](docs/SERVIDOR.md).

## Privacidade

- **Tudo roda no seu computador.** O PDF é aberto pelo navegador e **não sai do seu computador**.
- Com a voz de IA, o texto de cada frase vai só para o servidor local (`127.0.0.1`, o próprio
  computador), que devolve o áudio. Nada é enviado para a internet.
- O servidor só aceita conexões do próprio computador. Para usar pelo celular na rede Wi-Fi,
  existe a opção `--host 0.0.0.0` (veja [`docs/SERVIDOR.md`](docs/SERVIDOR.md)); use só em
  redes de confiança.
- Os ajustes e a posição de leitura ficam guardados no navegador (localStorage).
- A internet só é usada para baixar o pdf.js (na primeira abertura) e, na instalação, as
  bibliotecas e os modelos. As vozes "Online" do Edge e do Chrome, se você escolher a voz do
  navegador, também usam a internet.

## Solução de problemas

**"Voz de IA indisponível" nos ajustes**
- O servidor não está ligado: rode `scripts\iniciar.bat` e toque em **Verificar de novo**.
- A página foi aberta por outro servidor (ex.: "Servidor estático (sem IA)"): feche-o e abra
  http://localhost:8090 com o servidor de voz ligado.
- O painel mostra o motivo quando o modelo não está instalado; rode `scripts\instalar.bat` de novo.

**A primeira frase demora muito**
É o modelo sendo carregado (10 a 30 segundos). Se demorar sempre, veja se o painel diz
"Usando o processador (CPU)": nesse caso a placa de vídeo não foi encontrada. Atualize o driver
da NVIDIA e rode o instalador de novo.

**"Porta 8090 em uso"**
Outro programa (ou a tarefa "Servidor estático") já usa a porta. Feche-o, ou escolha outra
porta (veja [`docs/SERVIDOR.md`](docs/SERVIDOR.md)) e abra o endereço com essa porta.

**Falta memória na placa de vídeo**
Outros programas (jogos, geradores de imagem) podem estar usando a memória de vídeo. O servidor
libera a memória sozinho depois de um tempo sem uso; use o Kokoro, que é bem mais leve que o
Chatterbox.

**O Windows não deixa rodar os scripts**
Use os arquivos `.bat`: eles chamam os scripts do PowerShell só para esta execução, sem mudar
nenhuma configuração do Windows.

**Voz do navegador: nenhuma voz em português**
No Windows, vá em **Configurações > Hora e idioma > Fala > Adicionar vozes** e instale
"Português (Brasil)". Depois, feche e abra o navegador. No Edge, as vozes
"Microsoft Francisca Online (Natural)" e "Microsoft Antonio Online (Natural)" soam melhor.

**O PDF não tem texto para ler**
PDFs digitalizados (só imagens) não têm texto; não há reconhecimento de texto (OCR). O leitor
avisa quando as primeiras páginas não têm texto. PDFs com layout complicado (colunas, tabelas,
notas de rodapé) podem ser lidos fora da ordem ideal.

## Estrutura de pastas

```
web/                 o site (HTML, CSS e JavaScript puro, sem build)
  index.html
  css/               cores e tipografia, layout, componentes, visual do PDF
  js/main.js         ponto de entrada: liga PDF, voz e interface
  js/pdf/            abrir o PDF, extrair o texto em frases, mostrar as páginas (pdf.js)
  js/tts/            motores de voz (IA e navegador), detecção de idioma, leitura frase a frase
  js/ui/             cabeçalho, player, ajustes, arrastar e soltar, avisos
  js/utils/          armazenamento local, idiomas e utilitários de DOM
servidor/            servidor Python (python -m servidor): voz de IA + o site
scripts/             instalar e iniciar (Windows: .bat/.ps1; Linux: .sh)
docs/ARQUITETURA.md  contratos entre os módulos (leia antes de mexer no código)
docs/SERVIDOR.md     detalhes do servidor: opções, API, motores, configuração
.vscode/             tarefas e depuração
```

Detalhes técnicos: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) (site e contratos) e
[`docs/SERVIDOR.md`](docs/SERVIDOR.md) (servidor de voz).

## Licença

<!-- TODO (dono do projeto): escolher a licença (ex.: MIT ou Apache-2.0), criar o arquivo
     LICENSE e atualizar esta seção. -->
**TODO:** licença ainda não definida.
