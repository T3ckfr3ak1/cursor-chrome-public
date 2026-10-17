# Credits

Cursor-Chrome builds on open-source and industry components.

## Core runtime

| Component | Role | License (upstream) | Notice in this repo |
|-----------|------|--------------------|---------------------|
| [Electron](https://www.electronjs.org/) | App shell + Chromium embed | MIT | [LICENSE.electron.txt](LICENSE.electron.txt) |
| [Chromium](https://www.chromium.org/) | Rendering / CDP (via Electron) | BSD-style (Chromium) | [LICENSE.chromium](LICENSE.chromium); full credits in Electron’s `LICENSES.chromium.html` |
| [Node.js](https://nodejs.org/) | Scripts, MCP, agent client | MIT | Upstream |

## Direct dependencies (package.json)

| Package | Role | License |
|---------|------|---------|
| express | Local agent REST API | MIT |
| cors | CORS middleware (loopback) | MIT |
| ws | WebSocket live / control | MIT |
| uuid | IDs | MIT |

## Development / packaging

| Package | Role | License |
|---------|------|---------|
| electron-builder | Windows packager | MIT |
| sharp | Asset generation | Apache-2.0 |
| pngjs | PNG tooling | MIT |
| to-ico | Icon packaging | MIT |

## Design notes

- Shell chrome uses a **dark titanium / blue-steel** CSS surface (brushed gradients — no stock texture image).
- Logo assets are generated (`scripts/generate-logo.js`).

If you ship a binary build, retain LICENSE, LICENSE.chromium, LICENSE.electron.txt,
NOTICE, THIRD_PARTY_NOTICES.md, and Electron’s `LICENSES.chromium.html` beside the
installer or in the app resources.
