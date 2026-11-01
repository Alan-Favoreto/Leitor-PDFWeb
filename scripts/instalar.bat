@echo off
rem Instala a voz neural local do Leitor de PDF. Repassa as opcoes ao instalar.ps1:
rem   instalar.bat                 (pergunta sobre o Chatterbox)
rem   instalar.bat -ComChatterbox  (instala tambem o Chatterbox)
rem   instalar.bat -Cpu            (forca PyTorch de CPU)
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
set "ERRO=%ERRORLEVEL%"
rem pausa so quando aberto com duplo clique (para dar tempo de ler)
echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
exit /b %ERRO%
