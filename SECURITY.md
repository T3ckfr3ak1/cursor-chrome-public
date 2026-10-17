# Security

## Threat model

Cursor-Chrome is a **local agent power tool**, not a multi-user network service.

- Agent API: `http://127.0.0.1:9222` (no auth)
- Chromium CDP: `http://127.0.0.1:9223` (no auth)

Any process on the same machine that can open those ports can:

- Drive browser tabs (navigate, click, type, evaluate JS)
- Stream live page frames
- Attach local files into file inputs (`dropFiles`)
- Export / import session cookies for the shared profile

## Hard requirements

1. **Never** bind the API or CDP to `0.0.0.0` / LAN interfaces.
2. **Never** put long-lived PATs, passwords, or cookies into committed files or remote URLs.
3. Treat the shared profile (`persist:cursor-chrome-profile`) like a browser profile with logins — back it up only to private storage.
4. Public GitHub ships a **minimal** tree (`scripts/export-public.js`). Private remotes hold the full local tooling (Play Console scripts, internal dumps). Do not push private dumps to public.

## Reporting

If you find a vulnerability in the public distribution, open a private report to the maintainers rather than a public issue with exploit detail.
