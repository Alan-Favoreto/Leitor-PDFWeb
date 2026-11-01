# Leitor de PDF com Voz

Abra um PDF no navegador e ouça o texto lido em voz alta por uma **voz de IA que roda na sua
própria placa de vídeo**: sem conta, sem chave de API e sem mandar nada para a internet.
A frase e a palavra que estão sendo lidas ficam destacadas na página, e o leitor **descobre o
idioma de cada página** e troca de voz sozinho.

![Python 3.11](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![JavaScript sem build](https://img.shields.io/badge/JavaScript-sem%20build-F7DF1E?logo=javascript&logoColor=black)
![GPU NVIDIA opcional](https://img.shields.io/badge/GPU-NVIDIA%20opcional-76B900?logo=nvidia&logoColor=white)
![Windows | Linux](https://img.shields.io/badge/Windows%20%7C%20Linux-suportados-0078D6)

<!-- Dica: grave um GIF do leitor funcionando, salve em docs/demo.gif e descomente a linha abaixo.
<p align="center"><img src="docs/demo.gif" alt="Leitor de PDF lendo em voz alta com a frase destacada" width="720"></p>
-->

## Recursos

- **Voz humana gerada localmente** com o modelo [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
  (rápido e leve) ou, opcionalmente, o [Chatterbox](https://github.com/resemble-ai/chatterbox)
  (mais expressivo, aceita clonar uma voz).
- **Detecção automática de idioma** por página e por frase: português, inglês, espanhol,
  francês, italiano, hindi e chinês com o Kokoro; 23 idiomas com o Chatterbox.
- **Leitura contínua sem pausas:** as próximas frases são geradas enquanto a atual é lida.
- **Destaque da frase e da palavra** direto na página do PDF; toque em qualquer trecho para
  ler a partir dele.
- **Continua de onde você parou** em cada PDF (lembra até 50 arquivos).
- Velocidade e volume ajustáveis, tema claro e escuro, atalhos de teclado e uso no celular.
- **Sem servidor?** O site também funciona sozinho, com as vozes do navegador.

## Requisitos

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Windows 10/11 ou Linux x86-64 | Windows 11 |
| Placa de vídeo | nenhuma (roda no processador, mais devagar) | NVIDIA com 4 GB+ de VRAM (Kokoro) ou 6 GB+ (Chatterbox) |
| Disco | ~8,5 GB (ambiente Python + Kokoro) | +3 GB para o Chatterbox |
| Python | não precisa: o instalador baixa o Python 3.11 com o [uv](https://docs.astral.sh/uv/) | |
| Navegador | Edge, Chrome ou Firefox atualizados | |
| Internet | só na instalação e na primeira abertura do site | |

## Instalação

**1. Baixe o projeto**

```bash
git clone https://github.com/Alan-Favoreto/Leitor-PDFWeb.git
```

```bash
cd Leitor-PDFWeb
```

Ou use **Code → Download ZIP** no GitHub e extraia a pasta.

**2. Instale (só na primeira vez)**

- **Windows:** dê dois cliques em `scripts\instalar.bat`.
- **Linux:** rode `bash scripts/instalar.sh`.

O instalador cria a pasta `.venv` dentro do projeto, instala o PyTorch certo para a sua placa
de vídeo (ou a versão para processador, se não houver NVIDIA), baixa o modelo de voz e faz um
teste no final. Ele pergunta se você também quer o Chatterbox. Pode rodar de novo quando
quiser: só faz o que estiver faltando.

**3. Ligue o servidor**

- **Windows:** dê dois cliques em `scripts\iniciar.bat`.
- **Linux:** rode `bash scripts/iniciar.sh`.

Deixe a janela aberta enquanto usa o leitor. Para desligar, feche a janela ou aperte `Ctrl+C`.

**4. Abra no navegador:** http://localhost:8090

> Abrir o `web/index.html` com dois cliques não funciona: o navegador bloqueia os módulos
> JavaScript fora de um servidor.

### Opções do instalador

| Windows | Linux | O que faz |
|---|---|---|
| `scripts\instalar.bat -ComChatterbox` | `--com-chatterbox` | instala também o Chatterbox |
| `scripts\instalar.bat -SemChatterbox` | `--sem-chatterbox` | só o Kokoro (remove o Chatterbox, se existir) |
| `scripts\instalar.bat -Cpu` | `--cpu` | força a versão sem placa de vídeo |
| `scripts\instalar.bat -SemModelos` | `--sem-modelos` | baixa os modelos só no primeiro uso |

### Pelo VS Code

| Ação | Como |
|---|---|
| Instalar dependências | Terminal > Run Task > **Instalar dependências** |
| Ligar o servidor de voz | **Ctrl+Shift+B** |
| Só o site, sem IA | Terminal > Run Task > **Servidor estático (sem IA)** |
| Depurar no navegador | **F5** |

## Como usar

1. Toque em **Escolher PDF** ou arraste o arquivo para a janela.
2. Toque em **▶** para ouvir. A leitura continua de onde você parou ou começa na página que
   está na tela.
3. Toque em qualquer trecho do PDF para ler a partir dali.
4. No ícone de ajustes (canto superior direito), escolha:
   - **Motor de voz:** "Voz de IA (neste computador)" ou "Voz do navegador";
   - **Modelo e voz:** as vozes aparecem agrupadas por idioma;
   - **Idioma da leitura:** "Automático" (padrão) ou um idioma fixo;
   - **Velocidade e volume**, e **Testar voz**.

Na primeira frase, o modelo é carregado na placa de vídeo e aparece "Carregando voz de IA…"
(de 10 a 30 segundos). Depois de 10 minutos sem uso, o servidor libera a memória da placa de
vídeo para outros programas.

| Tecla | O que faz |
|---|---|
| Espaço | Ler / pausar |
| ← / → | Frase anterior / próxima |
| Esc | Parar (ou fechar os ajustes) |
| + / − | Aumentar / diminuir o zoom |

## Motores de voz

| | Kokoro (padrão) | Chatterbox (opcional) |
|---|---|---|
| Velocidade numa RTX 3060 | ~25× mais rápido que a fala | um pouco mais lento que a fala |
| Leitura contínua | sem pausas | pode ter pausas entre frases |
| Memória de vídeo | ~1 GB | ~3,6 GB |
| Idiomas | pt, en, es, fr, it, hi, zh | 23, inclusive pt |
| Vozes | prontas, por idioma (ex.: Dora, Alex e Santa em português) | uma voz multilíngue + vozes clonadas |
| Licença do modelo | Apache-2.0 | MIT |

Para usar uma voz própria no Chatterbox, coloque um áudio limpo de 7 a 20 segundos em
`servidor/vozes/` (use só vozes que você tem o direito de usar). Detalhes em
[`docs/SERVIDOR.md`](docs/SERVIDOR.md).

## Privacidade

- O PDF é aberto pelo navegador e **não sai do seu computador**.
- O texto de cada frase vai só para o servidor local (`127.0.0.1`), que devolve o áudio.
- O servidor só aceita conexões do próprio computador. Para usar pelo celular na rede Wi-Fi,
  existe a opção `--host 0.0.0.0`; use só em redes de confiança.
- Ajustes e posição de leitura ficam guardados no navegador.

## Solução de problemas

**"Voz de IA indisponível" nos ajustes:** o servidor não está ligado. Rode
`scripts\iniciar.bat` e toque em **Verificar de novo**.

**A primeira frase demora muito:** é o modelo carregando. Se o painel disser que está usando o
processador (CPU), atualize o driver da NVIDIA e rode o instalador de novo.

**"Porta 8090 em uso":** outro programa usa a porta. Feche-o ou inicie com
`scripts\iniciar.bat --port 8091` e abra http://localhost:8091.

**O Windows não deixa rodar os scripts:** use os arquivos `.bat`, que liberam os scripts do
PowerShell só durante a execução, sem mudar nenhuma configuração do Windows.

**O PDF não tem texto para ler:** PDFs digitalizados (só imagens) não têm texto, e o leitor
não faz reconhecimento de texto (OCR).

Mais casos em [`docs/SERVIDOR.md`](docs/SERVIDOR.md#solução-de-problemas).

## Estrutura do projeto

```
web/          o site: HTML, CSS e JavaScript puro, sem build e sem dependências
  js/pdf/     abre o PDF, extrai o texto em frases e mostra as páginas (pdf.js)
  js/tts/     motores de voz (IA e navegador), detecção de idioma, leitura frase a frase
  js/ui/      cabeçalho, player, ajustes, arrastar e soltar, avisos
servidor/     servidor Python (aiohttp) que gera a voz na GPU e serve o site
scripts/      instaladores e inicializadores para Windows e Linux
docs/         ARQUITETURA.md (como os módulos conversam) e SERVIDOR.md (API, opções, desempenho)
```

## Créditos

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), de hexgrad (Apache-2.0)
- [Chatterbox](https://github.com/resemble-ai/chatterbox), da Resemble AI (MIT)
- [pdf.js](https://mozilla.github.io/pdf.js/), da Mozilla (Apache-2.0)
- [espeak-ng](https://github.com/espeak-ng/espeak-ng) (GPL-3.0), usado pelo Kokoro para a
  pronúncia de alguns idiomas; é instalado como dependência e não faz parte deste código.

Os modelos são baixados pelo instalador direto das fontes oficiais e não fazem parte deste
repositório.

## Licença

Este projeto ainda não tem uma licença definida. Até lá, todos os direitos são reservados ao
autor.
