@echo off
rem Inicia o servidor do Leitor de PDF com voz (http://localhost:8090).
rem Repassa as opcoes, ex.: iniciar.bat --preload   ou   iniciar.bat --engine chatterbox
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" %*
set "ERRO=%ERRORLEVEL%"
if not "%ERRO%"=="0" (
  echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
)
exit /b %ERRO%
