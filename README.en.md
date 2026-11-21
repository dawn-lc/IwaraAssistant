# IwaraAssistant

[中文](README.md) ｜ [日本語](README.ja.md)

[![CI](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml/badge.svg)](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Firefox AMO](https://img.shields.io/amo/v/iwara-assistant?label=AMO&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![AMO users](https://img.shields.io/amo/users/iwara-assistant?label=users)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-5FA04E?logo=nodedotjs&logoColor=white)](package.json)

**Iwara Assistant** is a **browser extension** for [iwara.tv](https://www.iwara.tv) that aims to improve the site's batch downloading and video management experience.

> [!IMPORTANT]
> **Firefox is listed on [AMO](https://addons.mozilla.org/firefox/addon/iwara-assistant/)** (with automatic updates). **The Chrome Web Store rejected it** (content policy), so Chromium-based browsers have to load it manually — the functionality is identical to a store installation, and the reason is explained [below](#why-not-in-the-store).

> **For usage see the [Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki), for implementation see [docs/](docs/).** This file only covers what the extension is and how to install it.

## Features

| Area          | Capabilities                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download      | Four channels (built-in browser downloads / aria2 / iwaradl / open the direct link); path templates with live preview; detects cloud-drive links in descriptions and comments; batch de-duplication; adjustable browser download concurrency; retry on failure; metadata JSON |
| Page          | Card checkboxes with a cross-tab selection; select all / invert / clear; floating menu; manual video ID entry; beautification and widescreen; bottom-right watermark; rebuilt automatically after you switch pages                                                            |
| Tasks         | Three queue groups (needs attention / in progress / completed); progress; retry; removal cancels the download first; clear finished; checks with your downloader automatically on startup; toolbar badge                                                                      |
| Settings      | Nine tabs; saved as you change them; interface language `auto` / 中文 / English / 日本語; an invalid value falls back to the default automatically                                                                                                                            |
| Migration     | Imports the video library from the previous-generation userscript (IwaraDownloadTool) in one click; settings can be pasted in or imported from a migration package                                                                                                            |
| Notifications | A system notification pops up when background work has a result (queued, completed, failed, cloud-drive link found); click it to jump to the matching place                                                                                                                   |
| Security      | Phishing-site protection: when one is hit, the whole page becomes a warning and that page's requests are blocked, released only after you confirm "continue"                                                                                                                  |
| Social        | Auto follow / auto like; batch approval of friend requests (9 condition types, all of them or any of them)                                                                                                                                                                    |
| Sync          | Batch crawl of site-wide upload info (pausable / resumable / continues from the checkpoint); subscription feed; push to MediaCenter and back-fill in reverse                                                                                                                  |
| Privacy       | All data stays on your machine: no server, no analytics, nothing sent back to the developer — see [PRIVACY.md](PRIVACY.md)                                                                                                                                                    |

## Installation

| Browser                                       | How to install                                                                               | Notes                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Firefox 128+**                              | [Install from AMO](https://addons.mozilla.org/firefox/addon/iwara-assistant/)                | Reviewed and approved, updates automatically                           |
| Chrome / Edge / Brave / Vivaldi / Opera / Arc | Manual loading ([guide](https://github.com/dawn-lc/IwaraAssistant/wiki/Chromium-系手动安装)) | Rejected by the store, functionality identical to a store installation |

The two versions are **feature-identical**; the only differences come from two host restrictions: the Firefox version can reach an aria2 on your local network, and its background stays resident so long-running tasks are not reclaimed by the browser; the Chrome version can only reach the local machine's address, and when the browser is idle its background may be reclaimed, which interrupts tasks in progress (once you reopen it, the interruption is reported as it happened).

### Firefox (recommended)

Click "Add to Firefox" on the [AMO product page](https://addons.mozilla.org/firefox/addon/iwara-assistant/) and the installation is done. The listed version is whatever the product page shows; every release has to pass review, so the store is usually a day or two behind the latest commit in the repository.

To use mainline code right away, build locally and load it temporarily: `npm install && npm run build` → `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → choose `dist/firefox/manifest.json` (it is gone once Firefox exits).

### Chromium-based (Chrome / Edge / Brave / Vivaldi / Opera)

**Option 1: build from source** (requires Node ≥ 20.11) — `git clone` this repository, then `npm install && npm run build:chrome`; the output is in `dist/chrome`.
**Option 2: download a CI artifact** — go to [Actions](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml), pick the latest green run → Artifacts → `extension-zips` → extract `chrome.zip`.

Once you have the directory: open `chrome://extensions` (`edge://extensions` on Edge) → enable "Developer mode" → "Load unpacked" → choose the directory that **contains `manifest.json` directly** → reload the iwara pages that are already open. The full steps (including updating, rolling back, keeping data and troubleshooting) are in the [Wiki: manual installation for Chromium-based browsers](https://github.com/dawn-lc/IwaraAssistant/wiki/Chromium-系手动安装).

> Only take artifacts from this repository's source or from this repository's Actions. Zips / crx files republished by third parties cannot be checked against the source; do not use them.

### Why not in the store

The version submitted on 2026-10-30 was **rejected by the Chrome Web Store**: violation type "Content policies", reference ID `Grey Lithium` (sexually explicit content), on the grounds that "we do not allow products that ... direct users to such content".

The extension itself contains and displays no adult content: there are no explicit assets in the code, the icons are self-drawn SVG, and it neither proxies nor bypasses any site restriction. The actual reason for the rejection is **who it serves** — it only works on iwara.tv, and that site is an adult site. That is a Chrome prohibition rather than something that can be remediated, so there will be no further submission; the same code has already passed review on AMO. The rejection record, the appeal material and the reasoning behind "why not turn it into a general-purpose downloader" are in [docs/store-listing.md](docs/store-listing.md).

## Documentation

| Entry                                                      | Contents                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Wiki**](https://github.com/dawn-lc/IwaraAssistant/wiki) | For users: installation (including manual loading for Chromium-based browsers), download channels and endpoints, available path variables, batch delivery, task queue and automatic recovery, private and unlisted videos, legacy library migration, sync and MediaCenter, debugging and data export, troubleshooting, FAQ |
| [docs/05-features.md](docs/05-features.md)                 | The authoritative list of features and behaviour boundaries (including the trade-offs we "intentionally do not do")                                                                                                                                                                                                        |
| [docs/](docs/)                                             | Technical implementation: architecture, cross-browser differences, the manifest, messaging protocol, testing and releasing, aria2 flow, debug channels, AMO listing assets                                                                                                                                                 |

## Development

```bash
npm install          # Node >= 20.11
npm run build        # build both targets + package → dist/chrome, dist/firefox and the matching .zip files
npm run dev:chrome   # watch mode
npm run test:unit    # unit tests; plus test:e2e (Playwright) and test:e2e:wdio (Chrome + Firefox)
```

**Contributing**: read [CONTRIBUTING.md](CONTRIBUTING.md) first (environment, gates, commit conventions, PR flow); **before touching code you must read [AGENTS.md](AGENTS.md)** — the gate checklist, architecture invariants, directory placement and a set of "platform facts", with the measurements behind them in [docs/agent-notes.md](docs/agent-notes.md). For security vulnerabilities use the private channel in [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Dependencies and license

This project is open source under [Apache-2.0](LICENSE). Third-party dependencies (all runtime code is bundled into the extension, no remote code is ever loaded):

| Dependency                                                    | Purpose             | License |
| ------------------------------------------------------------- | ------------------- | ------- |
| [zod](https://github.com/colinhacks/zod)                      | Settings validation | MIT     |
| [idb](https://github.com/jakearchibald/idb)                   | Local video library | ISC     |
| [React](https://github.com/facebook/react) / react-dom        | Extension page UI   | MIT     |
| [i18next](https://github.com/i18next/i18next) / react-i18next | Three-language UI   | MIT     |
| [sonner](https://github.com/emilkowalski/sonner)              | In-page toasts      | MIT     |
| [dayjs](https://github.com/iamkun/dayjs)                      | Time formatting     | MIT     |

Development and build toolchain: TypeScript (Apache-2.0), esbuild (MIT), tsx (MIT), Prettier (MIT), Playwright (Apache-2.0), WebdriverIO (MIT), web-ext (MPL-2.0), resvg (MPL-2.0). The icons are SVGs drawn inside the repository and rendered at build time; no third-party assets are used.

## Related projects and acknowledgements

- [IwaraDownloadTool](https://github.com/IwaraEnhance/IwaraDownloadTool) (Apache-2.0): the **previous generation by the same author**, a userscript. Iwara Assistant is its successor as a browser extension — it inherits the feature set and a number of edge-case behaviours, and the migration page brings the old script's video library and settings across.
- [iwaradl](https://github.com/Izumiko/iwaradl) (MIT): a CLI downloader, used here as one of the download backends.
- [MediaCenter](https://github.com/dawn-lc/MediaCenter): a local media library, and the experimental metadata push target.
- [aria2](https://github.com/aria2/aria2) and [Motrix-Next](https://github.com/AnInsomniacy/motrix-next): the recommended self-hosted downloader and graphical front end.

Thanks to everyone who filed issues, provided real-world logs and helped verify fixes — most of the "platform facts" were corrected on the strength of that feedback.

## Relationship with Iwara and disclaimer

- This project is an independently developed third-party tool and has **no partnership, authorisation or affiliation** with Iwara.
- It only interacts through pages and APIs that the site itself makes publicly available: it does not bypass access controls, does not crack any paid or private content, and does not proxy or relay videos.
- Please make sure for yourself that downloading complies with the laws of your jurisdiction and with Iwara's terms of service; the developer and contributors are not liable for the consequences of use, including but not limited to account restrictions.
- If you like the content on the site, please support the creators first: get [Iwara Premium](https://www.iwara.tv/page/premium) or tip the author directly.
- This project is open source under [Apache-2.0](LICENSE); the code and documentation are provided "as is", without any express or implied warranty.

## Privacy and license

The extension collects no data and sends nothing back to the developer; the two uses of its permissions are described in [the Wiki's permission notes](https://github.com/dawn-lc/IwaraAssistant/wiki/安装与首次配置#权限说明为什么需要全站访问). The privacy policy is in [PRIVACY.md](PRIVACY.md), and the license is [Apache-2.0](LICENSE).
