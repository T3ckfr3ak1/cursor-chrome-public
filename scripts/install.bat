@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>&1 || (
  echo Node.js is required. Install from https://nodejs.org/ then re-run.
  exit /b 1
)
node "%~dp0agent-install.js" %*
exit /b %ERRORLEVEL%
