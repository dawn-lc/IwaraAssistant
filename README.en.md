# IwaraAssistant

[中文](README.md) ｜ [日本語](README.ja.md)

[![CI](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml/badge.svg)](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Firefox AMO](https://img.shields.io/amo/v/iwara-assistant?label=AMO&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![AMO users](https://img.shields.io/amo/users/iwara-assistant?label=users)](https://addons.mozilla.org/firefox/addon/iwara-assistant/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-5FA04E?logo=nodedotjs&logoColor=white)](package.json)

A browser extension for iwara.tv. It moves batch video downloading, selection and management into an interface that is actually usable: the site itself keeps only the high-frequency "tick / download" actions, while settings, the task queue, progress and migration all happen on the extension's own pages.

- **Chrome (MV3) and Firefox (MV2) share the same code base** and behave identically.
- Four download channels: built-in browser downloads, aria2, iwaradl, and opening the direct link for an external downloader.
- System notifications are the only channel for result feedback; one click takes you where you need to go.
- Nothing is collected and nothing is sent back to the developer.

> A guided tour and more troubleshooting steps live in the [Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki); technical implementation (architecture, cross-browser differences, manifests, messaging protocol, testing and releasing) is split across the [docs/](docs/) directory, while this document only covers how to use the extension.

> [!IMPORTANT]
> **Firefox: available on AMO**, [install here](https://addons.mozilla.org/firefox/addon/iwara-assistant/) (updates automatically).
> **Chrome Web Store: rejected** (2026-10-30, reference ID `Grey Lithium`: content policy / sexually explicit content). This is a prohibition at the level of product positioning and cannot be remedied by changing code — for Chromium-based browsers, load the extension manually as described in the [manual installation guide for Chromium-based browsers](docs/07-install-chromium.md); functionality is identical to a store installation. See [below](#why-it-is-not-in-the-store) for the reasons and the trade-offs.

## Features

| Area          | Capabilities                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download      | Four channels; path templates with live preview; link pre-checks; batch de-duplication; concurrency limit for the browser channel; retry on failure; metadata JSON                                        |
| Page          | Card checkboxes with a selection shared across tabs; select all / invert / deselect; floating menu; manual ID entry; beautification and widescreen; corner watermark; automatic re-scan on SPA navigation |
| Tasks         | Queue groups (needs attention / in progress / completed); progress; retry; removal (cancels the downloader first); clear finished; reconciliation on startup; toolbar badge                               |
| Settings      | Nine tabs; instant save; interface language `auto` / 中文 / English / 日本語; settings validation and defaults                                                                                            |
| Migration     | Automatically detects the old userscript's page database read-only, with an explicit one-click import; settings accept pasted raw JSON or a complete migration package                                    |
| Notifications | Only events that happen in the background (queued, completed, failed, cloud drive link found) use system notifications; clicking jumps to the corresponding video page or task page                       |
| Security      | Phishing and look-alike site protection: full-screen warning plus network-level blocking, released only after the user explicitly chooses "continue".                                                     |
| Social        | Auto follow / auto like; batch approval of friend requests (9 conditions, any / all modes, live progress)                                                                                                 |
| Sync          | Full pagination crawl of all uploads into the library; subscription feed sync; MediaCenter push                                                                                                           |

Feature details and behaviour boundaries are in [docs/05-features.md](docs/05-features.md).

## Installation

| Browser                                       | How to install                                                                | Notes                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Firefox 128+**                              | [Install from AMO](https://addons.mozilla.org/firefox/addon/iwara-assistant/) | Reviewed and approved, updates automatically                           |
| Chrome / Edge / Brave / Vivaldi / Opera / Arc | Manual loading ([guide](docs/07-install-chromium.md))                         | Rejected by the store, functionality identical to a store installation |

### Firefox (recommended)

On the [AMO product page](https://addons.mozilla.org/firefox/addon/iwara-assistant/) click "Add to Firefox" and confirm the permissions; later versions then update automatically.

- The listed version is whatever the [AMO product page](https://addons.mozilla.org/firefox/addon/iwara-assistant/) shows (the badge comes from the same source). Every release has to pass AMO review, so the store version is usually a day or two behind the latest commit in the repository; to use the mainline code immediately, load it temporarily as described below.
- Requires at least **Firefox 128** (`strict_min_version`); AMO refuses anything older.
- The published package is **MV2**, so an aria2 instance on your local network works directly with `http://192.168.x.x:6800/jsonrpc`, unaffected by the MV3 local network restrictions.

To temporarily load the latest code from the repository:

```bash
npm install    # Node >= 20.11
npm run build  # → dist/chrome, dist/firefox and the matching .zip files
```

Open `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → choose `dist/firefox/manifest.json`. Temporary add-ons are gone once Firefox exits; load them again after restarting.

### Chromium-based (Chrome / Edge / Brave / Vivaldi / Opera)

Functionally identical to a store installation, it just has to be loaded manually once. The complete steps (including updating, rolling back, keeping data and troubleshooting) are in **[docs/07-install-chromium.md](docs/07-install-chromium.md)**; shortest path:

**Option 1: build from source** (requires Node ≥ 20.11)

```bash
git clone https://github.com/dawn-lc/IwaraAssistant.git
cd IwaraAssistant
npm install
npm run build:chrome   # → dist/chrome
```

**Option 2: download a CI artifact** (no Node needed, but you must be signed in to GitHub; artifacts are kept for 14 days)

Go to [Actions](https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml), pick the latest green run → Artifacts at the bottom of the page → download `extension-zips` → extract `chrome.zip` and then extract that.

Once you have the directory: open `chrome://extensions` (`edge://extensions` on Edge) → enable "Developer mode" → "Load unpacked" → choose the directory that **contains `manifest.json` directly**. Then reload the iwara pages that are already open.

> Only take artifacts from this repository's source or from this repository's Actions. Zips / crx files republished by third parties cannot be checked against the source; do not use them.

### Why it is not in the store

Version 0.1.31, submitted on 2026-10-30, was **rejected by the Chrome Web Store**: violation type "Content policy", reference ID `Grey Lithium` (sexually explicit content), and the remediation request was to "remove all sexually explicit content/code", citing "we do not allow products that ... direct users to such content". The matching entry on the official troubleshooting page puts it more plainly: **the extension's primary purpose is to improve a website that provides sexually explicit content**.

The extension itself contains and displays no adult content: there are no explicit assets in the code, the icons are self-drawn SVG, all JavaScript is bundled inside the package, and it neither proxies nor bypasses the site's access restrictions. The actual reason for the rejection is **who the extension serves** — it only applies to iwara.tv, and that site is an adult site. This is one of Chrome's prohibitions rather than a remediable item (the policy text asks to "unpublish" instead of "fix and resubmit"), and the "adult content" switch was already checked when submitting yet the decision still held, so the extension will not be submitted to the Chrome Web Store again.

Turning the extension into a "general-purpose downloader" or erasing the site name just to pass review is not acceptable — that would trip the clauses on deceptive behaviour, keyword stuffing and minimum functionality at the same time, and the nature of the site would not change anyway. The very same code has already passed review on AMO: [Mozilla's content policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) only require that trademarks, the AUP and US law are respected, and contain no Chrome-style prohibition about **who the add-on serves**.

`npm install` also enables the git hooks shipped with the repository (format on commit, validate the commit message, run the local gate before pushing); if you only install and do not develop, you can ignore this, or turn it off with `git config --unset core.hooksPath`.

### Permissions

The extension declares site-wide access (`<all_urls>`), used in exactly two places:

1. The endpoints of the download channels are entered by the user (aria2 / iwaradl / MediaCenter), so the domains cannot be written into the manifest in advance;
2. Phishing and look-alike site protection needs to read the **host name** of arbitrary sites in order to decide.

Apart from those two points the extension only works on `iwara.tv`. The detailed rationale is in [docs/03-manifest.md](docs/03-manifest.md#全站-host-权限一次声明两处用途).

## Usage

### Downloading a single video

Three entry points, pick any one:

| Entry point  | Where                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| In-page menu | the menu slides out from the right edge of a video detail page → "Download current video" |
| Context menu | right-click a video link or a video page → "Iwara Assistant → Download this video"        |
| Manual entry | in-page menu → "Manual download", paste video IDs (separate several with `\|`)            |

A video ID is the segment after `/video/` in the address bar. For example, the ID of `https://www.iwara.tv/video/AeGUIRO2D5vQ6F` is `AeGUIRO2D5vQ6F`.

### Batch downloads

1. On a video list page, in-page menu → "Toggle checkboxes" (or press `Space`) so the cards show checkboxes.
2. Tick the cards you want to download. The menu also offers "Select all on this page", "Invert selection on this page", "Deselect this page" and "Clear all selections".
3. In-page menu → "Download selected".

A few notes:

- **The selection is shared across tabs**: what you ticked in tab A still counts after switching to tab B.
- Videos that were already downloaded or are currently downloading are skipped, so no duplicate tasks pile up in the downloader.
- As soon as a video reaches a conclusion (queued, failed, skipped) it is unchecked automatically; there is nothing to clear by hand.
- Submissions in a batch are 3 seconds apart to avoid triggering site rate limiting.

### Task queue

Click the toolbar icon → "Task queue" (or select the "Tasks" tab in the extension options). The list has three groups, and **items needing attention are always at the top**:

| Group           | Meaning                         | What each row does                                                                                             |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Needs attention | failed / cloud drive link found | "Retry" or "Open video page" (the item is removed automatically once opened)                                   |
| In progress     | queued / downloading            | watch the progress; a downloading item can be "removed", which cancels the download before deleting the record |
| Completed       | completed / delivered           | history, can be cleared                                                                                        |

"Refresh status" at the top reconciles with aria2 / iwaradl immediately, without waiting for the periodic scan.

### Key settings

Extension options → "Download" tab:

| Setting                            | Default                                   | Description                                                                                                                              |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Download method                    | built-in browser download                 | also aria2 / iwaradl (endpoints must be configured first) / open direct link (no longer tracked after delivery)                          |
| Concurrent downloads               | 3                                         | only applies to the browser channel; concurrency for aria2 / iwaradl is controlled by those tools themselves                             |
| Save path template                 | `/Iwara/%#AUTHOR#%/%#TITLE#%[%#ID#%].mp4` | variables are listed under [Paths and file names](#paths-and-file-names); a live preview sits below the input                            |
| Third-party cloud drive link check | off                                       | when enabled, a cloud drive link in the description or comments means the video is **not downloaded**, leaving an item for you to decide |
| Auto-copy saved file name          | off                                       | when a cloud drive link is detected, put the file name on the clipboard                                                                  |

The other tabs: RPC (endpoint and environment self-check), Filter (list rewriting), Clean-up (file name rules), Friends, Migration, Advanced (experimental features, interface language, background keep-alive), Guide.

The full list is in [docs/05-features.md](docs/05-features.md#配置与多语言).

### Paths and file names

The path template is configured on the "Download" tab and supports the following variables (case-sensitive; the variable name is what sits between `%#` and `#%`):

| Variable         | Meaning                        | Example output                        |
| ---------------- | ------------------------------ | ------------------------------------- |
| `%#AUTHOR#%`     | author user name               | `Mr.Quin`                             |
| `%#ALIAS#%`      | author nickname (may be empty) | `摸鱼奎恩`                            |
| `%#TITLE#%`      | video title                    | `【Quin】黑暗之魂3 一周目攻略 Part22` |
| `%#ID#%`         | video ID                       | `MrQuinWo22Ne22`                      |
| `%#QUALITY#%`    | quality actually downloaded    | `Source` / `540` / `360`              |
| `%#UploadTime#%` | video upload time              | `2022-02-22`                          |
| `%#NowTime#%`    | current time at submission     | `2022-02-22`                          |

`%#UploadTime#%` and `%#NowTime#%` accept a [dayjs](https://day.js.org/docs/en/display/format) format string, and each occurrence is parsed independently: `%#NowTime:YYYY-MM-DD_HH.mm.ss#%` → `2022-02-22_22.22.22`; without a format string they are always `YYYY-MM-DD` (not the raw timestamp).

Full example (Windows drive letters, Unix absolute paths and relative paths are all supported; UNC paths `\\server\share` and `..` escapes are rejected with a message):

```text
D:/Iwara/%#AUTHOR#%/(%#ALIAS#%)%#UploadTime:YYYY-MM-DD#%_%#TITLE#%_%#QUALITY#%[%#ID#%].mp4
```

Rendered result:

```text
D:\Iwara\Mr.Quin\(摸鱼奎恩)2022-02-22_【Quin】黑暗之魂3 一周目攻略 Part22_Source[MrQuinWo22Ne22].mp4
```

The "Clean-up" tab controls the file name normalisation chain: NFKC normalisation → emoji replacement → combining mark folding → replacement of characters illegal on Windows → length truncation (titles default to 72, nicknames to 64). These rules apply only to `%#TITLE#%` and `%#ALIAS#%`; every other variable is expanded verbatim.

Channels use paths differently: **aria2 / iwaradl** receive the full directory plus file name (and create directories according to the template); **built-in browser downloads** only accept a file name relative to the browser's download directory, so the drive letter and root are stripped while subdirectories are preserved (both hosts create directories automatically); **open direct link** passes only the file name as a hint to the external downloader.

### Notifications

No toasts and no progress bars inside the page — all status feedback goes through system notifications. Clicking a notification takes you to the corresponding place:

- task-related → task queue;
- cloud drive link found / external video failed → that video page (or the external original address).

Notifications for failures and "needs attention" items persist until you dismiss them or handle the item in the task queue.

### Migrating from the old userscript

In the extension options → "Migration" tab:

1. **Automatic detection**: after you open any iwara page, the extension probes, read-only, the database the old script left in the page and shows the number of entries.
2. **Explicit import**: go back to the migration page and click import. Keep that iwara tab open during the import (only the page itself can read that data).
3. **Settings can only be pasted**: the old script keeps its settings in the userscript manager's private storage, which the page cannot read. Use its "export settings" to copy the text and paste it into the paste box on the migration page; importing a complete migration package exported by this extension is also supported.

The result honestly reports the number of written / skipped / failed entries instead of hiding lost data behind a single "import succeeded". See [docs/05-features.md](docs/05-features.md#数据与迁移) for details.

### Phishing and look-alike site protection

Enabled by default, no configuration needed. When a suspected look-alike domain is hit:

1. the page is replaced with a full-screen warning and **all requests from that tab are blocked at the network layer**;
2. only clicking "Continue" (a real click, which page scripts cannot forge) lets the request through, and only for the current host name;
3. the rules are cleared automatically once you leave the site and do not affect later browsing.

## FAQ

**Why can't I find it in the Chrome Web Store?**
Rejected on 2026-10-30, reference ID `Grey Lithium` (content policy / sexually explicit content); the reason given was that the extension's "primary purpose is to improve a website that provides sexually explicit content". This is a prohibition, changing code cannot solve it, and it will not be resubmitted. For Chromium-based browsers load it manually, see the [manual installation guide for Chromium-based browsers](docs/07-install-chromium.md).

**After loading it, the browser says the extension is "untrusted" or does not come from the store?**
That is a fixed marker for non-store extensions (the browser's policy on sideloading); it cannot be turned off, can simply be ignored, and does not affect any functionality.

**The version installed from AMO is older than the latest commit in the repository?**
That is normal. Every AMO release has to be reviewed, so the store will never equal the commit you just pushed. The listed version currently matches the repository version (0.1.32); to use the latest mainline code early, run `npm run build` locally and load `dist/firefox/manifest.json` temporarily. A temporary add-on and the store version do not conflict with each other, but it is best to keep only one to avoid two instances injecting at the same time.

**I clicked download, so why did it not start downloading but appear under "needs attention"?**
"Third-party cloud drive link check" is enabled and the video's description or comments contain a cloud drive link. Not downloading is deliberate: open the video page and decide for yourself whether to use the cloud drive or the downloader, then click "Force download" once you are sure.

**The video says "private video" and retrying does not help?**
Such videos are visible only to the author's friends, regardless of your login state. Go to the author's profile, add them as a friend, and click "Retry" once they accept.

**Firefox cannot reach an aria2 instance on the local network?**
The Firefox artifact in this repository is **MV2**, so it is not subject to the local network access restrictions Firefox applies to MV3 extensions; plain http addresses on the LAN work directly. If you changed it to an MV3 build yourself, only `127.0.0.1` or `https` will work (see [docs/02-cross-browser.md](docs/02-cross-browser.md) for details).

**A task cannot be deleted?**
A task that is downloading needs its downloader cancelled before the record is deleted (the first click on "Remove" turns into "Confirm cancel?", and the second click executes it). If the state is "delivered" (handed to an external downloader), deleting the record on the extension side does not stop the other side.

**Why does it need site-wide access?**
See "Permissions" above; it is used in exactly two places.

**Does the extension upload my data?**
No. All data stays local, see [PRIVACY.md](PRIVACY.md).

**Downloads are slow, or the same task keeps being rebuilt in aria2?**
First check which channel it is. On the aria2 side `max-connection-per-server` and `split` are set explicitly when submitting (both default to 4 and can be changed on the "Download" tab) — upstream aria2 defaults these to **1** and 20M, so without explicit values you get a single connection and no segmentation for small files. If it is still slow, check the proxy bandwidth, aria2's global `max-overall-download-limit`, and the connection count you entered yourself. Tasks below **16 KiB/s** on two consecutive samples (one sample per minute) are restarted automatically (the direct link is re-resolved and the address swapped in place); this is deliberate behaviour, not a hang. Once progress is past 98% the restart is skipped, except when the speed is 0 (that means the connection is dead).

**A task stays in "queued" forever?**
The concurrency limit of the browser channel (default 3) is at work: tasks beyond it wait for the previous one to finish, so that dozens of transfers do not hit the same CDN at once. After switching to aria2 / iwaradl, "queued" is decided by their own concurrency limits and has nothing to do with this extension.

**Parsing fails / it says I have no permission?**
Three common causes: the direct link expired (just click download again and the extension re-resolves it; 403 responses on the aria2 side are rebuilt automatically from the error payload), the preferred quality is unobtainable all the way down the ladder (lower the preferred quality on the "Download" tab or change your network environment), or the login state expired (log in to iwara.tv again and reload the page). Private videos require a mutual friendship with the author; this kind of access control is outside what the extension can bypass.

**Notifications do not show up?**
The extension uses system notifications as its only feedback: first make sure the browser's notification permission is not disabled in the operating system and that "focus mode / do not disturb" is off. Suppressed notifications do not affect the tasks themselves; the task queue and the toolbar badge still update.

**Is my data still there after upgrading or reinstalling the extension?**
Upgrading with the same extension ID keeps everything: settings, queue and video library live in `browser.storage.local` and the extension's own IndexedDB. Only when you "remove" the extension on the extension management page does the browser wipe the data along with it — to back it up manually, export a complete migration package from the "Migration" tab.

**Installed but nothing happens / no checkboxes on the page?**
Check in order: ① whether you reloaded the iwara tab (pages already open when the extension was installed or updated are not injected automatically); ② whether the current page is a video list page or a video detail page (other pages never have checkboxes); ③ whether "automatically inject checkboxes" on the "Download" tab was turned off (if it is off, pressing `Space` still enables them manually); ④ on Chrome-based browsers, whether you loaded the directory that directly contains `manifest.json` rather than its parent. More detailed troubleshooting steps are in [docs/10-troubleshooting.md](docs/10-troubleshooting.md).

## Relationship with Iwara and disclaimer

- This project is an independently developed third-party tool and has **no partnership, authorisation or affiliation** with Iwara.
- It interacts only through the pages and APIs the site itself publicly provides: it does not bypass access controls, does not crack any paid or private content, and does not proxy or relay videos.
- Please make sure your downloading complies with local laws and regulations and with Iwara's terms of service; the developer and contributors are not liable for the consequences of use, including but not limited to account restrictions.
- If you like the content on the site, please support the creators first: take out an [Iwara Premium membership](https://www.iwara.tv/page/premium) or tip the author directly.
- This project is open source under [Apache-2.0](LICENSE); the code and documentation are provided "as is", without any express or implied warranty.

## Development

Technical implementation details are split by topic under `docs/`:

| Document                                                    | Contents                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [01-architecture.md](docs/01-architecture.md)               | design principles, runtime contexts, source layout, injection timing and security, UI stack, state and permissions              |
| [02-cross-browser.md](docs/02-cross-browser.md)             | `browser` namespace strategy, shims, browser difference matrix and Firefox specifics                                            |
| [03-manifest.md](docs/03-manifest.md)                       | deriving the two manifests, the single source of truth for the version, permission list, CSP and packaging                      |
| [04-messaging.md](docs/04-messaging.md)                     | messaging protocol, fully compatible listeners, the MAIN ⇄ ISOLATED bridge, background routing                                  |
| [05-features.md](docs/05-features.md)                       | current features, download channels, queue semantics, notifications, settings, migration, social and phishing protection        |
| [06-testing-and-release.md](docs/06-testing-and-release.md) | development commands, test layers, CI, git hooks, release process and open items                                                |
| [07-install-chromium.md](docs/07-install-chromium.md)       | manual installation on Chromium-based browsers: getting artifacts, loading, updating, keeping data and troubleshooting          |
| [08-aria2-flow.md](docs/08-aria2-flow.md)                   | aria2 task management flow: three entry points, scanning and reconciliation, state mapping, failure and cancellation sequencing |
| [09-debug-bridge.md](docs/09-debug-bridge.md)               | debug bridge: the extension connects out to a local debug service; snapshots, log ring, allowlisted commands                    |
| [10-troubleshooting.md](docs/10-troubleshooting.md)         | troubleshooting: nothing happens after install, parsing failures, aria2 unreachable, stuck tasks, collecting logs and exports   |
| [store-listing.md](docs/store-listing.md)                   | AMO listing assets and copy, Chrome Web Store rejection record                                                                  |

**Contributing**: read [CONTRIBUTING.md](CONTRIBUTING.md) first (environment, gate, commit conventions, PR process). For security vulnerabilities use the private channel described in [SECURITY.md](SECURITY.md) instead of opening a public issue.

**Read [AGENTS.md](AGENTS.md) before you start developing**: the gate checklist, architecture rules, directory placement, code conventions, and a set of "platform facts" (Chrome's termination conditions, the capability boundaries of Firefox MV2, aria2 methods that do not exist). The incidents and measurements behind these rules are recorded in [docs/agent-notes.md](docs/agent-notes.md) — when you wonder "why can't this be written that way", look there first instead of changing code according to general convention.

Common commands (full list and test layers in [docs/06](docs/06-testing-and-release.md#开发命令)):

```bash
npm run build        # dual-target build + store packages
npm run dev:chrome   # watch mode
npm run test:unit    # unit tests
npm run test:e2e     # Playwright e2e
```

## Dependencies and licenses

This project is open source under [Apache-2.0](LICENSE). Third-party dependencies (all runtime code is bundled into the extension; no remote code is loaded):

| Dependency                                                    | Purpose                                  | License |
| ------------------------------------------------------------- | ---------------------------------------- | ------- |
| [zod](https://github.com/colinhacks/zod)                      | settings schema and dirty-data fallback  | MIT     |
| [idb](https://github.com/jakearchibald/idb)                   | Promise wrapper around IndexedDB         | ISC     |
| [React](https://github.com/facebook/react) / react-dom        | extension page UI                        | MIT     |
| [i18next](https://github.com/i18next/i18next) / react-i18next | three-language interface and copy checks | MIT     |
| [sonner](https://github.com/emilkowalski/sonner)              | in-page toasts                           | MIT     |
| [dayjs](https://github.com/iamkun/dayjs)                      | time formatting for path templates       | MIT     |

Development and build toolchain: TypeScript (Apache-2.0), esbuild (MIT), tsx (MIT), Prettier (MIT), Playwright (Apache-2.0), WebdriverIO (MIT), web-ext (MPL-2.0), resvg (MPL-2.0). The icons are SVGs drawn in this repository and rendered at build time; no third-party assets are referenced.

## Similar projects and acknowledgements

- [IwaraDownloadTool](https://github.com/IwaraEnhance/IwaraDownloadTool) (Apache-2.0): this project's feature set and a number of boundary behaviours were informed by that userscript; the migration tab exists for its long-time users.
- [iwaradl](https://github.com/Izumiko/iwaradl) (MIT): a CLI downloader that this project uses as one download backend.
- [MediaCenter](https://github.com/dawn-lc/MediaCenter): a local media library, the experimental metadata push target.
- [aria2](https://github.com/aria2/aria2) and [Motrix-Next](https://github.com/AnInsomniacy/motrix-next): the recommended self-hosted downloader and its GUI.

Thanks to everyone who filed issues, provided measurement logs and helped verify fixes — most of the "platform facts" were corrected thanks to that feedback.

## Privacy and license

The extension collects no data and sends nothing back to the developer; see [PRIVACY.md](PRIVACY.md) for details. The license is [Apache-2.0](LICENSE).
