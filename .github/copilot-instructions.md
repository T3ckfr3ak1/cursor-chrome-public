<!-- GitHub surfaces this for tools that read repository instruction files. -->
# Instructions for AI coding agents

This repository is **Cursor-Chrome** — install and drive a local agent Chromium browser.

**If the user says "install this" (or equivalent):** follow **[/INSTALL.md](/INSTALL.md)** and **[/AGENTS.md](/AGENTS.md)** end-to-end.

Immediate actions:

1. `npm run install:agent` when this repo is the workspace, **or**
2. Windows bootstrap when only the URL was given:
   `irm https://raw.githubusercontent.com/T3ckfr3ak1/cursor-chrome-public/main/scripts/remote-bootstrap.ps1 | iex`
3. Verify `GET http://127.0.0.1:9222/health` returns `"ok": true`.

Do not stop at "here's how you would install it." Execute until health succeeds or a hard environment error remains after a fix attempt.
