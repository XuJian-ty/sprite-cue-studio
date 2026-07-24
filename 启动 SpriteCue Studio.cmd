@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%PROJECT_ROOT%scripts\start-sprite-cue-studio.ps1"
start "" /b "%PS%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT%"
endlocal
exit /b 0
