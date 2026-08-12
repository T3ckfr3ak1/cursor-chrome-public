# Maintain Gitea + GitHub remotes (maintainers / Cursor agents)

> **Private monorepo only** (`C:\dev\Cursor\Cursor-Chrome` with Gitea remote).  
> Public consumers of `cursor-chrome-public` do **not** run this.

## Goal

Every time this project changes, **all three** remotes stay current:

| Remote | What gets updated |
|--------|-------------------|
| **Gitea** `IronwoodApps/cursor-chrome` | Full private tree (`main`) including large installers |
| **origin** (same as Gitea) | Full private tree |
| **GitHub private** `T3ckfr3ak1/cursor-chrome` | Clean mirror of current tree (**no** `builds/` >100MB history) |
| **GitHub public** `T3ckfr3ak1/cursor-chrome-public` | Minimal MIT export (`scripts/export-public.js`) |

Agents must **never** report success if any required remote failed. Hooks + maintain run automatically; agents re-run `npm run maintain:remotes` when shipping now.

```text
  local commit
       │
       ├─► post-commit hook ──► maintain:remotes (bg)
       │         │
       │         ├─► git push gitea/origin  (full tree)
       │         ├─► push-github-private   (clean mirror + token, no GCM)
       │         └─► export-public → public GitHub (token, no GCM)
       │
       └─► after push lands on Gitea
                 │
                 └─► CI workflow ──► export-public → public GitHub
```

---

## GitHub auth (no credential popups)

| Source | Path / env |
|--------|------------|
| Stored PAT | `%LOCALAPPDATA%\Cursor-Chrome\secrets\github-token` |
| Env | `GITHUB_TOKEN` / `GH_TOKEN` / `PUBLIC_GITHUB_TOKEN` |
| One-time create | `npm run github:token` → opens **Cursor-Chrome** (your saved GitHub login) |

Maintain forces `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`.  
**Cursor-Chrome is required** for any GitHub web / login / token setup. No Windows GCM account picker. No OS Chrome.

---

## Layer A — Local automatic (git hooks)

### 1. Install once

```bat
npm run hooks:install
```

Hooks: `post-commit`, `post-merge`, `post-rewrite` → background `maintain:remotes`.

### 2. Work as usual

```bat
git add -A
git commit -m "your message"
```

Logs: `logs/maintain-remotes.log` · `logs/maintain-remotes-last.json`

### Manual

```bat
npm run maintain:remotes
npm run github:token
npm run github:private
```

| Flag / env | Effect |
|------------|--------|
| `--quick` | Skip docs:sync |
| `--no-public` / `SKIP_PUBLIC=1` | Only private remotes |
| `--no-private` / `SKIP_PRIVATE=1` | Only public export |
| `SKIP_GITHUB_PRIVATE=1` | Skip clean-mirror only (escape hatch) |
| `--background` | Detach (hooks) |
| `CURSOR_CHROME_SKIP_MAINTAIN=1` | No-op |

---

## Layer B — CI

Gitea / GitHub Actions export public and optional mirrors. Secrets: `PUBLIC_GITHUB_TOKEN`, optional `PRIVATE_GITHUB_TOKEN`.

---

## Cursor agent rules (binding)

1. Hooks fire → remotes update.  
2. Ship now: `npm run maintain:remotes`.  
3. Verify `logs/maintain-remotes-last.json` has Gitea + github + public all `ok: true`.  
4. GitHub work uses **Cursor-Chrome** + saved token — never GCM popups.  

Do **not** leave any of the three remotes stale after a finished feature.

---

## Known limits

1. **GitHub private** cannot receive Gitea’s raw history with >100MB `builds/` blobs — maintain uses **clean mirror force-push** of the current tree instead.  
2. **Detached HEAD** skips local maintain pushes.  
3. First-time token: Cursor-Chrome open + logged into GitHub; then silent.

---

## Files

| Path | Role |
|------|------|
| `scripts/maintain-remotes.js` | Local orchestrator |
| `scripts/publish-remotes.js` | Gitea + public + private mirror |
| `scripts/push-github-private.js` | Clean private GitHub mirror |
| `scripts/github-token.js` | Token resolve / Cursor-Chrome create |
| `scripts/export-public.js` | Minimal public tree |
| `logs/maintain-remotes-last.json` | Last result — agents must read this |
