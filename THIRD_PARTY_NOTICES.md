# Third-party notices

Cursor-Chrome redistributes or depends on third-party software. Upstream
licenses apply to those components. This file is a convenience index — full
license texts for Electron and Chromium are also in:

- [LICENSE.electron.txt](LICENSE.electron.txt)
- [LICENSE.chromium](LICENSE.chromium)

## Electron / Chromium (required attribution)

Cursor-Chrome is an **Electron** application. Electron embeds **Chromium**.
This project’s own code is MIT ([LICENSE](LICENSE)). Electron and Chromium
remain under their upstream licenses.

### Electron (MIT)

See [LICENSE.electron.txt](LICENSE.electron.txt). Upstream:
https://github.com/electron/electron

### Chromium (BSD-style)

Chromium is licensed under a 3-clause BSD-style license. The copyright notice,
conditions, and disclaimer required by that license are reproduced in
[LICENSE.chromium](LICENSE.chromium).

**Binary redistributions:** When you install or package Cursor-Chrome, Electron
places `LICENSES.chromium.html` beside the app binaries. That file is the full
Chromium + third-party credits tree. Do **not** strip it from installers or
packaged apps — retaining it satisfies Chromium’s binary-redistribution notice
requirement for the embedded browser stack.

**Source redistributions of this repo:** This public tree does not include
Chromium source. Keep `LICENSE.chromium`, `LICENSE.electron.txt`, this file,
and [NOTICE](NOTICE) with any substantial copy of Cursor-Chrome.

**Non-endorsement (Chromium BSD clause 3):** Neither the name of Google LLC nor
the names of its contributors may be used to endorse or promote products
derived from this software without specific prior written permission.
Cursor-Chrome is **not** affiliated with, endorsed by, or sponsored by Google
LLC, Google Chrome, or the Chromium Authors.

**Trademarks (separate from the open-source license):** “Chrome”, “Chromium”,
and “Google Chrome” are trademarks of Google LLC. Cursor-Chrome is an
independent Electron shell; do not imply it is Google Chrome.

## npm production dependencies

### express (MIT)
https://github.com/expressjs/express

### cors (MIT)
https://github.com/expressjs/cors

### ws (MIT)
https://github.com/websockets/ws

### uuid (MIT)
https://github.com/uuidjs/uuid

## npm development dependencies

### electron-builder (MIT)
https://github.com/electron-userland/electron-builder

### sharp (Apache-2.0)
https://github.com/lovell/sharp

### pngjs (MIT)
https://github.com/luke-chang/pngjs / https://github.com/pngjs/pngjs

### to-ico (MIT)
https://github.com/kevva/to-ico

---

**No warranty.** Cursor-Chrome and its dependencies are provided as-is. See LICENSE.
