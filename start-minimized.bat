@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" (
  start "" "%ELECTRON%" "%~dp0." --minimized
) else (
  start "" /B npx --yes electron . --minimized
)
endlocal
