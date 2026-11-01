<#
.SYNOPSIS
  Instala a voz neural local do Leitor de PDF (Windows).

.DESCRIPTION
  Cria o ambiente .venv (Python 3.11 via uv), instala o PyTorch certo para a sua placa
  (CUDA para NVIDIA, senão CPU), o motor Kokoro e, se pedir, o Chatterbox. Depois baixa os
  modelos e faz um teste curto. Pode rodar de novo quando quiser: só faz o que falta.

.PARAMETER ComChatterbox
  Instala também o Chatterbox (voz mais expressiva; +3 GB de download, ~3,5 GB de VRAM).

.PARAMETER SemChatterbox
  Não instala o Chatterbox (e remove o pacote, se já estiver instalado).

.PARAMETER Cpu
  Força o PyTorch de CPU, mesmo com placa NVIDIA.

.PARAMETER SemModelos
  Não baixa os modelos agora (eles baixam no primeiro uso).

.PARAMETER SemTeste
  Pula o teste de voz no final.

.EXAMPLE
  scripts\instalar.bat
  scripts\instalar.bat -ComChatterbox
#>
[CmdletBinding()]
param(
  [switch]$ComChatterbox,
  [switch]$SemChatterbox,
  [switch]$Cpu,
  [switch]$SemModelos,
  [switch]$SemTeste
)

# 'Continue': erros de programas externos são tratados pelo código de saída ($LASTEXITCODE).
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONUTF8 = '1'
$env:UV_LINK_MODE = 'copy'            # cache do uv e projeto podem estar em discos diferentes
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'

$TorchVersion  = '2.8.0'
$PythonVersion = '3.11'
$ChatterboxPkg = 'chatterbox-tts @ https://github.com/resemble-ai/chatterbox/archive/5de7a54aa4e5e2baadb0182dde554908b48b85c2.zip'

$Raiz   = Split-Path -Parent $PSScriptRoot
$Venv   = Join-Path $Raiz '.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
Set-Location $Raiz

function Passo([string]$Texto) { Write-Host ''; Write-Host "==> $Texto" -ForegroundColor Cyan }
function Ok([string]$Texto)    { Write-Host "    $Texto" -ForegroundColor Green }
function Info([string]$Texto)  { Write-Host "    $Texto" }
function Aviso([string]$Texto) { Write-Host "    $Texto" -ForegroundColor Yellow }
function Falha([string]$Texto) {
  Write-Host ''
  Write-Host "ERRO: $Texto" -ForegroundColor Red
  Write-Host 'Veja "Solução de problemas" em docs\SERVIDOR.md.' -ForegroundColor Red
  exit 1
}

Write-Host 'Leitor de PDF com voz: instalação da voz neural local' -ForegroundColor Cyan
Write-Host "Pasta do projeto: $Raiz"

# --------------------------------------------------------------------------- espaço em disco
function Espaco-Livre-GB([string]$Caminho) {
  try {
    $letra = (Resolve-Path $Caminho).Drive.Name
    return [math]::Round((Get-PSDrive -Name $letra).Free / 1GB, 1)
  } catch { return $null }
}
$livre = Espaco-Livre-GB $Raiz
if ($livre -ne $null -and $livre -lt 9) {
  Aviso "Pouco espaço livre no disco do projeto ($livre GB). O ambiente com PyTorch CUDA ocupa ~7 GB."
}

# --------------------------------------------------------------------------- uv
Passo 'Procurando o uv (gerenciador de pacotes Python)'
$script:UvExe = $null
$script:UvPre = @()

function Testar-Uv([string]$Exe, [string[]]$Pre) {
  $out = & $Exe @Pre --version 2>$null
  return ($LASTEXITCODE -eq 0 -and "$out" -match '^uv ')
}

$cmd = Get-Command uv -ErrorAction SilentlyContinue
if ($cmd -and (Testar-Uv $cmd.Source @())) {
  $script:UvExe = $cmd.Source
} else {
  # tenta "python -m uv" com um Python já instalado (ignora o atalho da Microsoft Store)
  $pythons = @()
  foreach ($nome in @('py', 'python', 'python3')) {
    $c = Get-Command $nome -ErrorAction SilentlyContinue
    if ($c -and $c.Source -notlike '*\WindowsApps\*') { $pythons += $c.Source }
  }
  foreach ($py in $pythons) {
    if (Testar-Uv $py @('-m', 'uv')) { $script:UvExe = $py; $script:UvPre = @('-m', 'uv'); break }
  }
  if (-not $script:UvExe -and $pythons.Count -gt 0) {
    $py = $pythons[0]
    Info "Instalando o uv com: $py -m pip install --user uv"
    & $py -m pip install --user --disable-pip-version-check --quiet uv
    if ($LASTEXITCODE -eq 0 -and (Testar-Uv $py @('-m', 'uv'))) { $script:UvExe = $py; $script:UvPre = @('-m', 'uv') }
  }
  if (-not $script:UvExe) {
    $local = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path $local)) {
      Info 'Baixando o uv pelo instalador oficial (astral.sh)…'
      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    }
    if ((Test-Path $local) -and (Testar-Uv $local @())) { $script:UvExe = $local }
  }
}
if (-not $script:UvExe) {
  Falha 'Não consegui instalar o uv. Instale manualmente (https://docs.astral.sh/uv/) e rode de novo.'
}

function Uv {
  & $script:UvExe @script:UvPre @args
  if ($LASTEXITCODE -ne 0) { Falha "o comando 'uv $($args -join ' ')' falhou (código $LASTEXITCODE)." }
}
$uvVersao = & $script:UvExe @script:UvPre --version
Ok "Usando $uvVersao"

# --------------------------------------------------------------------------- .venv
Passo "Ambiente Python $PythonVersion (.venv)"
$recriar = $true
if (Test-Path $VenvPy) {
  $versao = & $VenvPy -c "import sys; print('%d.%d' % sys.version_info[:2])"
  if ($LASTEXITCODE -eq 0 -and "$versao".Trim() -eq $PythonVersion) {
    $recriar = $false
    Ok "Já existe ($versao)."
  } else {
    Aviso "O .venv existente usa Python '$versao'; vou recriá-lo com $PythonVersion."
    Remove-Item -Recurse -Force $Venv
  }
} elseif (Test-Path $Venv) {
  Aviso 'O .venv existente está incompleto; vou recriá-lo.'
  Remove-Item -Recurse -Force $Venv
}
if ($recriar) {
  Info "Criando o .venv (o uv baixa o Python $PythonVersion se precisar)…"
  Uv venv $Venv --python $PythonVersion
  Ok 'Criado.'
}

# --------------------------------------------------------------------------- GPU e PyTorch
Passo 'Placa de vídeo e PyTorch'
$indice = 'cpu'
if ($Cpu) {
  Info 'Opção -Cpu: usando o PyTorch de CPU.'
} else {
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  $smiExe = if ($smi) { $smi.Source } elseif (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe") { "$env:SystemRoot\System32\nvidia-smi.exe" } else { $null }
  if ($smiExe) {
    $linhas = & $smiExe --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader 2>$null
    if ($LASTEXITCODE -eq 0 -and $linhas) {
      $campos = (@($linhas)[0] -split ',') | ForEach-Object { $_.Trim() }
      $nome = $campos[0]; $cc = 0.0; $drv = $campos[2]
      [void][double]::TryParse($campos[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cc)
      $drvMaior = 0; [void][int]::TryParse(($drv -split '\.')[0], [ref]$drvMaior)
      Ok "GPU NVIDIA: $nome ($($campos[3]), driver $drv, compute $($campos[1]))"
      if ($cc -ge 10.0) { $indice = 'cu128' }           # RTX 50xx (Blackwell) e mais novas
      elseif ($cc -ge 5.0) { $indice = 'cu126' }
      else { Aviso 'Placa antiga demais para o PyTorch atual; usando a CPU.' }
      if ($indice -ne 'cpu' -and $drvMaior -gt 0 -and $drvMaior -lt 528) {
        Aviso "Driver NVIDIA $drv é antigo para CUDA 12. Atualize o driver (nvidia.com/drivers)."
        Aviso 'Se a voz não usar a GPU depois, rode de novo com -Cpu.'
      }
    } else {
      Aviso 'nvidia-smi não respondeu; usando o PyTorch de CPU.'
    }
  } else {
    Info 'Nenhuma placa NVIDIA encontrada: usando o PyTorch de CPU (funciona, mas é mais lento).'
  }
}
$torchQuero = "$TorchVersion+$indice"
$torchTenho = & $VenvPy -c "import importlib.metadata as m; print(m.version('torch'))" 2>$null
if ($LASTEXITCODE -ne 0) { $torchTenho = '' }
$torchTenho = "$torchTenho".Trim()
if ($torchTenho -eq $torchQuero) {
  Ok "PyTorch $torchTenho já instalado."
} else {
  if ($torchTenho) { Info "Trocando o PyTorch $torchTenho por $torchQuero…" }
  else { Info "Instalando o PyTorch $torchQuero (download grande: ~2,5 GB com CUDA)…" }
  $extra = @()
  if ($torchTenho) { $extra = @('--reinstall-package', 'torch', '--reinstall-package', 'torchaudio') }
  Uv pip install --python $VenvPy "torch==$TorchVersion" "torchaudio==$TorchVersion" --index-url "https://download.pytorch.org/whl/$indice" @extra
  Ok "PyTorch $torchQuero instalado."
}

# --------------------------------------------------------------------------- Kokoro
Passo 'Servidor e motor Kokoro (requirements.txt)'
Uv pip install --python $VenvPy -r (Join-Path $Raiz 'requirements.txt')
Ok 'Pronto.'

# --------------------------------------------------------------------------- Chatterbox
Passo 'Motor Chatterbox (opcional)'
$cbInstalado = Test-Path (Join-Path $Venv 'Lib\site-packages\chatterbox\mtl_tts.py')
if ($ComChatterbox) { $querCb = $true }
elseif ($SemChatterbox) { $querCb = $false }
elseif ($cbInstalado) { $querCb = $true; Info 'Já instalado; conferindo as dependências.' }
elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Write-Host '    O Chatterbox é uma voz mais expressiva (23 idiomas), porém mais lenta e pesada:'
  Write-Host '    +3 GB de download e ~3,5 GB de memória de vídeo. O Kokoro continua disponível.'
  $resp = Read-Host '    Instalar o Chatterbox também? [s/N]'
  $querCb = "$resp".Trim().ToLower() -in @('s', 'sim', 'y', 'yes')
} else { $querCb = $false }

if ($querCb) {
  Uv pip install --python $VenvPy -r (Join-Path $Raiz 'requirements-chatterbox.txt')
  # --no-deps: o pacote fixa torch==2.6.0 e puxa o gradio (só das demos); ver requirements-chatterbox.txt
  Uv pip install --python $VenvPy --no-deps $ChatterboxPkg
  Ok 'Chatterbox instalado.'
} elseif ($SemChatterbox -and $cbInstalado) {
  Uv pip uninstall --python $VenvPy chatterbox-tts
  Ok 'Chatterbox removido (o Kokoro continua).'
} else {
  Info 'Pulado. Para instalar depois: scripts\instalar.bat -ComChatterbox'
}

# confere se nada trocou o PyTorch no caminho
$torchFinal = (& $VenvPy -c "import importlib.metadata as m; print(m.version('torch'))").Trim()
if ($torchFinal -ne $torchQuero) {
  Aviso "O PyTorch mudou para $torchFinal durante a instalação; reinstalando $torchQuero…"
  Uv pip install --python $VenvPy "torch==$TorchVersion" "torchaudio==$TorchVersion" --index-url "https://download.pytorch.org/whl/$indice" --reinstall-package torch --reinstall-package torchaudio
}

# --------------------------------------------------------------------------- modelos e teste
if (-not $SemModelos) {
  Passo 'Baixando os modelos (ficam no cache do Hugging Face, na sua pasta de usuário)'
  & $VenvPy -m servidor --baixar-modelos
  if ($LASTEXITCODE -ne 0) { Falha 'não consegui baixar os modelos. Confira a internet e rode de novo.' }
}
if (-not $SemTeste -and -not $SemModelos) {
  Passo 'Teste rápido de voz'
  & $VenvPy -m servidor --testar
  if ($LASTEXITCODE -ne 0) { Falha 'o teste de voz falhou (mensagens acima).' }
}

Write-Host ''
Write-Host 'Instalação concluída!' -ForegroundColor Green
Write-Host '  Para iniciar:  scripts\iniciar.bat   (ou: scripts\iniciar.ps1 --preload)'
Write-Host '  Depois abra:   http://localhost:8090'
exit 0
