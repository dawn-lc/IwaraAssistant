# 06 测试与发布

## 开发命令

全部入口都在 `package.json` 的 scripts 里；CI 与 git 钩子调用的也是这些命令，不另设一套。

| 命令                                       | 作用                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `npm run build`                            | 双目标编译 + 打包 → `dist/chrome(.zip)`、`dist/firefox(.zip)`        |
| `npm run build:chrome`                     | 仅 Chrome（MV3 service worker）                                      |
| `npm run build:firefox`                    | 仅 Firefox（MV2 持久后台页）                                         |
| `npm run dev:chrome` / `dev:firefox`       | watch 模式（只监听 JS；html/css/manifest 改动需重跑）                |
| `npm run lint:firefox`                     | `web-ext lint`（应为 0 error / 0 notice）                            |
| `npm run package`                          | 仅重打包已有 `dist`（`package:chrome` / `package:firefox` 可单目标） |
| `npm run build:icons`                      | 导出图标 PNG 到 `assets/icons`（构建不依赖，构建期自渲染）           |
| `npm run type-check`                       | 扩展源码 + 单测                                                      |
| `npm run type-check:e2e`                   | Playwright specs                                                     |
| `npm run type-check:wdio`                  | WDIO specs                                                           |
| `npm run test:unit`                        | 单元测试（`node:test`）                                              |
| `npm run test:e2e` / `test:e2e:headless`   | Playwright e2e（有头 / 无头）                                        |
| `npm run test:e2e:wdio[:chrome\|:firefox]` | WebdriverIO 跨浏览器 e2e                                             |
| `npm run test:firefox:smoke`               | `web-ext run` 装载冒烟                                               |
| `npm run format` / `format:check`          | prettier（提交时钩子会自动格式化暂存文件）                           |
| `npm run fixtures:capture`                 | 刷新站点结构快照与 API 录制响应（需过 Cloudflare）                   |

> 需要环境变量的脚本统一写成 `node --import tsx/esm ./build/env.ts KEY=VALUE … -- <命令>`（实现在 `build/env.ts`）。
> 不要在 scripts 里重写 `node -e "process.env.X=…"`：引号规则在 PowerShell / cmd / bash 各不相同。

版本号只有一个真源（`package.json`），发版用 `npm version patch|minor|major`；规则与校验见 [03](03-manifest.md#版本号真源packagejson)。

## 测试分层

| 层             | 命令                         | 覆盖范围与定位                                                                                                                                         |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 单元测试       | `npm run test:unit`          | `node:test` + tsx，零框架依赖。纯函数与状态机：路径清洗、模板变量、配置 schema、页面路由、消息协议、旧库分批预算、任务对账/取消策略、i18n 键一致性等。 |
| 类型检查       | `npm run type-check` 等三条  | 扩展源码、Playwright e2e、WDIO e2e 分别检查；CI 中三条都跑。                                                                                           |
| Playwright e2e | `npm run test:e2e`           | Chromium 直载 `dist/chrome`，10 个 spec / 51 个用例；CI 门禁。                                                                                         |
| WDIO 常规套件  | `npm run test:e2e:wdio`      | Chrome + Firefox 同一份用例，25 个用例共享同一 session；本机运行，不进 CI。                                                                            |
| WDIO live      | `npm run test:e2e:wdio:live` | 真实站点与真实 aria2；`E2E_LIVE=1` 才收集，13 个站点用例 + 4 个下载用例，不进 CI。                                                                     |
| 手动验收       | `npm run test:e2e:manual`    | `E2E_MANUAL=1`，无断言，加载真实 profile 供人工检查；Chrome / Firefox 各一条脚本。                                                                     |
| Firefox 冒烟   | `npm run test:firefox:smoke` | `web-ext run` 验证装载、`boot()` 与事件链。                                                                                                            |

### Playwright

- 直载扩展：`launchPersistentContext` + `--load-extension`，固定 `chromium` 通道（品牌 Chrome 137+ 已移除 flags 侧载），worker 级单会话并捕获 SW console。
- 站点页面使用**脱敏后的真实结构快照** `e2e/playwright/fixtures/iwara-list.html`；`api.iwara.tv` 使用同一次抓取录制的响应 `e2e/playwright/fixtures/api/*.json`，由 `mockIwaraApi()` 回放。
- 快照由 `npm run fixtures:capture` 在本地 headed Chrome 中刷新（需要过 Cloudflare）；CI 只读快照，不访问外网。
- 覆盖：SW 启动、options 九页签、配置持久化与默认值、任务队列表格与操作、popup 深链、消息链路、旧库导入、迁移粘贴、界面语言、引导页、钓鱼防护三层拦截、页内 fetch 钩子与真实 API 响应回放、选择模式。
- 断言语言固定为 `zh-CN`（`locale` + `--lang`）；迁移用例额外把 `config.language` 写成 `zh`，因为导入写 config 会让 `watchLanguage` 重新解析 `auto`。

### WebdriverIO

- 双宿主同构：Chrome 通过 `webExtension.install`，Firefox 通过 geckodriver `--allow-system-access` + 固定 UUID 导航 `moz-extension://`。
- `e2e/wdio/extension.spec.ts` 故意保持单文件：每个 spec 文件都会重建 session，而 25 个用例依赖同一份 storage 演进（空队列 → 建任务 → 清队列）；撤销权限用例必须最后执行。
- live 套件只做只读操作，不点下载类动作；遇到 Cloudflare 挑战直接 skip，`E2E_HUMAN=1` 可切换为人工过盾。

## CI

`.github/workflows/ci.yml` 有两个并行 job：

| Job            | 内容                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `verify`       | 安装依赖 → 三条类型检查 → 单元测试 → 双目标构建（含 ZIP）→ `web-ext lint` → 上传 `dist/*.zip` 产物（保留 14 天） |
| `e2e-chromium` | 安装依赖 → 按 Playwright 版本缓存 Chromium → 构建 `dist/chrome` → 无头 Playwright e2e                            |

约定：

- 同一分支连推会取消上一轮（`concurrency.cancel-in-progress`）。
- `permissions: contents: read`，job 超时 15 / 25 分钟。
- **runner 钉 `ubuntu-24.04`，不用 `ubuntu-latest`**：后者从 2026-10-19 起分几周切到 Ubuntu 26.04（11-19 完成），期间同一标签在 24.04 / 26.04 之间**随机落点**（[actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)）——同一个 commit 重跑一次结果可能不同。钉住后 OS 变更是一次显式提交、带自己的绿跑；升级只需把 `runs-on` 改成 `ubuntu-26.04`。
- **action 全部使用 Node 24 运行时**（`checkout@v7` / `setup-node@v7` / `cache@v6` / `upload-artifact@v7`）：v4 系列仍声明 Node 20，会被强制跑在 Node 24 上并每轮刷 deprecation 警告。这几个大版本的破坏性变更只有「迁移到 ESM」与新增可选参数，本项目未受影响。
- **CI 不检查格式**（prettier）：格式由 `pre-commit` 钩子保证（见下一节），CI 不必再为它设门。它一旦变红会让单测/构建/`web-ext lint`/上传全部 `skipped`——用「没按空格」清零整条流水线的验证价值。
- CI 不跑 WDIO，因此设置 `CHROMEDRIVER_SKIP_DOWNLOAD=true` 跳过后安装下载；将来加 WDIO job 时在该 job 覆盖为 `false`。
- Playwright 浏览器缓存键使用 `@playwright/test` 自身版本，依赖变动不会无谓失效。
- CI 全程零外网依赖；真实站点冒烟与 WDIO 跨浏览器套件只在本地运行。

## Git 钩子：把能自动化的都自动化

三道钩子按**成本分层**：提交时只做毫秒级的事，慢的检查放到推送前那次不可撤销的动作之前。

| 钩子         | 做什么                                                                    | 成本   | 为什么放这一层                                                            |
| ------------ | ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `pre-commit` | 格式化**本次暂存**的文件并重新暂存                                        | 毫秒级 | 每次提交都跑，慢一次就会被 `--no-verify` 永久绕过                         |
| `commit-msg` | 校验提交消息符合 `<type>: <说明>`                                         | 微秒级 | 约定只存在于人的记忆里；混进无前缀消息后，按前缀检索/changelog 就不可靠了 |
| `pre-push`   | 跑一遍 **CI 的 verify job**（类型检查 ×3 → 单测 → 构建 → `web-ext lint`） | 几十秒 | 推送前最后一次机会；等 CI 变红再回来至少多一轮往返                        |

| 文件                                        | 职责                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.githooks/pre-commit` + `formatStaged.mjs` | 只处理暂存文件                                                                              |
| `.githooks/commit-msg` + `checkMessage.mjs` | 消息格式（允许 `npm version` 的纯版本号与 git 生成的 Merge/Revert/fixup）                   |
| `.githooks/pre-push` + `prePush.mjs`        | 本地门禁，与 CI 逐步同序                                                                    |
| `.githooks/install.mjs`                     | 把 `core.hooksPath` 指向 `.githooks`（由 `prepare` 在 `npm install` / `npm ci` 后自动执行） |

**为什么不能把钩子直接放 `.git/hooks`**：那个目录不进版本控制，克隆后就是空的。官方唯一可分发机制是 `core.hooksPath`，因此需要一次配置——挂在 `prepare` 上就不需要用户记任何命令（它永不失败：非 git 环境、浅克隆、用户已自设 hooksPath 都静默跳过）。

### 格式化的三条安全性质（写错会丢用户的工作）

1. **只碰暂存的文件**（`git diff --cached --diff-filter=ACMR`），不扫工作区。
2. **暂存内容与工作区不一致时阻止提交**：部分暂存（改了 A 段 add、又改了 B 段没 add）时，格式化工作区再 `git add` 会把 B 段一起提交。提示里给出两种解决办法（全部暂存 / `git stash push --keep-index`）。
3. **与 `npm run format` 同一套判据**：`.prettierignore` + prettier 能否推断出 parser（`*.json`、`dist`、`temp`、`reference`、录制快照全部跳过）。

格式化失败（文件有语法错误）时阻止提交并打印 prettier 原话——那种情况不可能「帮你改好」。

### 推送前门禁的取舍

- **唯一的跳过规则**：本次推送的改动**全是 `.md`** 时跳过（文档不可能影响类型/构建）。判据取保守方向——算不出改动清单（新分支、远端 ref 不在本地、stdin 为空）一律跑全量。
- **不做更细的增量判定**（例如「只改了测试就只跑单测」）：错误地跳过比多跑几十秒贵得多。
- 任何一步失败即中断，**完整输出原样呈现**（不截断、不摘要），并给出跳过办法。

逃生阀：`git commit --no-verify` / `git push --no-verify`，或 `SKIP_FORMAT_HOOK=1` / `SKIP_PUSH_CHECKS=1`。调试用 `HOOK_REFS="<ref> <localSha> <ref> <remoteSha>"` 复现某次推送的判定。

## 发布流程

```bash
npm version patch|minor|major   # 唯一版本真源：package.json
npm run build                   # 双目标构建 + 校验 + 打包 → dist/chrome.zip、dist/firefox.zip
npm run lint:firefox            # web-ext lint，应为 0 error / 0 notice
```

- 版本号由 `build/version.ts` 校验：1–4 段十进制整数、无前导零、每段 ≤ 65535、不得全零、不接受预发布标识；校验失败会在清理 `dist` 之前终止构建。
- Chrome 产物为 MV3，`minimum_chrome_version: 111`；Firefox 产物由 `build/manifestV2.ts` 从同一 base 改写成 MV2，`strict_min_version: 128.0`。
- Firefox `browser_specific_settings.gecko.data_collection_permissions.required = ["none"]`，与 [PRIVACY.md](../PRIVACY.md) 一致。
- 商店文案、权限理由与截图清单见 [store-listing.md](store-listing.md)。

### 发布前检查清单

前四项在 `git push` 时已由 `pre-push` 钩子自动执行（失败会直接阻止推送），这里列出来是为了手工复核时有据可查：

1. `npm run type-check && npm run type-check:e2e && npm run type-check:wdio`
2. `npm run test:unit`
3. `npm run build`
4. `npm run lint:firefox`
5. 需要时本地 e2e：`npm run test:e2e:wdio`（Chrome + Firefox）
6. 上传 `dist/firefox.zip` 至 AMO，按商店要求填写权限用途与隐私声明；`dist/chrome.zip` 仅作存档（Chrome Web Store 已拒，见 [store-listing.md](store-listing.md#拒绝记录2026-10-30)）

> 格式化不需要手动跑：提交时钩子会自动处理暂存的文件（见「Git 钩子」）。
> 想整仓收拾一遍仍可用 `npm run format`。

## 未完成事项（代码之外）

| 事项                  | 状态       | 说明                                                                                                                                                                                                                                                                              |
| --------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 商店宣传图 440×280    | 不再需要   | Chrome Web Store 专用尺寸，不提交后无用途；素材要求留档在 [store-listing.md](store-listing.md) 第四节                                                                                                                                                                             |
| Chrome Web Store 提交 | **不提交** | 0.1.31 于 2026-10-30 被拒（`Grey Lithium`，内容政策）：判定依据是「主要用途为改进提供露骨色情内容的网站」，属禁止项而非可整改项。拒绝记录见 [store-listing.md](store-listing.md#拒绝记录2026-10-30)。Chromium 系改为手动加载，见 [07-install-chromium.md](07-install-chromium.md) |
| AMO（Firefox）提交    | **已上架** | [iwara-assistant](https://addons.mozilla.org/firefox/addon/iwara-assistant/)，上架版本 **0.1.30**（2026-10-29 通过审核）；仓库当前 0.1.32，发版后走「新版本」上传即可                                                                                                             |
| AMO 商品页素材        | 部分完成   | 三语描述与摘要、主页（仓库）、支持站点（issues）已于 2026-10-31 填入；**图标与截图仍缺**。「实验性」按作者决定保留（尚未达到发布标准），取消后曝光度才会恢复。文案与清单见 [store-listing.md](store-listing.md) 第二、三节                                                        |

## 风险与约束

- Firefox 使用 MV2 以避开 MV3 的本地网络访问限制；若 Firefox 未来移除 MV2，需要重新评估 `webRequest` / 代理方案。详见 [02-cross-browser.md](02-cross-browser.md)。
- MAIN 世界注入可被页面检测或绕过，因此安全判定都在后台完成，不依赖钩子生效。详见 [01-architecture.md](01-architecture.md#注入时机与安全)。
- 旧库迁移是跨 origin 读取，必须保持「检测自动、导入显式」与逐条校验，不能改成静默自动导入。
- 浏览器通道没有字节级进度；不要为了补齐进度而轮询 `downloads.search`，那会让 SW 常驻。
