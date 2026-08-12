#requires -Version 5.1
<#
.SYNOPSIS
  One-shot bootstrap for Cursor agents / users on Windows.

.DESCRIPTION
  Clones (or updates) cursor-chrome-public into a stable path, then runs
  scripts/agent-install.js for full npm install + skill + minimized launch.

.EXAMPLE
  # From PowerShell (user or Cursor agent):
  irm https://raw.githubusercontent.com/T3ckfr3ak1/cursor-chrome-public/main/scripts/remote-bootstrap.ps1 | iex

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File remote-bootstrap.ps1
#>

$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:CURSOR_CHROME_REPO) { $env:CURSOR_CHROME_REPO } else { 'https://github.com/T3ckfr3ak1/cursor-chrome-public.git' }
$InstallRoot = if ($env:CURSOR_CHROME_HOME) {
  $env:CURSOR_CHROME_HOME
} else {
  Join-Path $env:USERPROFILE 'cursor-chrome'
}

function Ensure-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found on PATH: $Name"
  }
}

Write-Host "=== Cursor-Chrome remote bootstrap ===" -ForegroundColor Cyan
Write-Host "Install path: $InstallRoot"
Write-Host "Repo:         $RepoUrl"

Ensure-Command git
Ensure-Command node
Ensure-Command npm

if (-not (Test-Path (Join-Path $InstallRoot '.git'))) {
  $parent = Split-Path -Parent $InstallRoot
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $InstallRoot) {
    # Empty or non-git folder: only allow if empty-ish
    $existing = Get-ChildItem -Force $InstallRoot -ErrorAction SilentlyContinue
    if ($existing -and $existing.Count -gt 0) {
      throw "Path exists and is not a git repo: $InstallRoot — set CURSOR_CHROME_HOME or remove it"
    }
    git clone $RepoUrl $InstallRoot
  } else {
    git clone $RepoUrl $InstallRoot
  }
} else {
  Push-Location $InstallRoot
  try {
    git fetch origin
    git pull --ff-only origin main 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "ff-only pull failed; leaving existing clone (install will still run)" -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
}

$installJs = Join-Path $InstallRoot 'scripts\agent-install.js'
if (-not (Test-Path $installJs)) {
  throw "agent-install.js missing after clone — is the repo URL correct?"
}

Write-Host "Running agent install…" -ForegroundColor Cyan
Push-Location $InstallRoot
try {
  node scripts/agent-install.js
  if ($LASTEXITCODE -ne 0) { throw "agent-install.js exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done. Cursor-Chrome should answer: http://127.0.0.1:9222/health" -ForegroundColor Green
Write-Host "Client: $InstallRoot\src\client.js"
Write-Host "Point Cursor agents at this install path and THREAD-PROTOCOL.md"
