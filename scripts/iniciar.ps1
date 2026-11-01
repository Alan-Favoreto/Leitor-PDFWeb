# Inicia o servidor do Leitor de PDF com voz usando o .venv do projeto.
# Todos os argumentos vão para "python -m servidor" (ex.: --preload, --port 8091, --host 0.0.0.0).
$Raiz = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Raiz '.venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not (Test-Path $Py)) {
  Write-Host 'A voz neural ainda não foi instalada. Rode primeiro: scripts\instalar.bat' -ForegroundColor Red
  exit 1
}
# "ativa" o .venv para este processo
$env:VIRTUAL_ENV = $Venv
$env:PATH = (Join-Path $Venv 'Scripts') + ';' + $env:PATH
$env:PYTHONUTF8 = '1'
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Set-Location $Raiz
& $Py -m servidor @args
exit $LASTEXITCODE
