# 06 测试与发布

## 测试分层

| 层             | 命令                         | 覆盖范围与定位                                                                                                                                         |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 单元测试       | `npm run test:unit`          | `node:test` + tsx，零框架依赖。纯函数与状态机：路径清洗、模板变量、配置 schema、页面路由、消息协议、旧库分批预算、任务对账/取消策略、i18n 键一致性等。 |
| 类型检查       | `npm run type-check` 等三条  | 扩展源码、Playwright e2e、WDIO e2e 分别检查；CI 中三条都跑。                                                                                           |
| Playwright e2e | `npm run test:e2e`           | Chromium 直载 `dist/chrome`，10 个 spec / 48 个用例；CI 门禁。                                                                                         |
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

| Job            | 内容                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `verify`       | 安装依赖 → 三条类型检查 → prettier 格式检查 → 单元测试 → 双目标构建（含 ZIP）→ `web-ext lint` → 上传 `dist/*.zip` 产物（保留 14 天） |
| `e2e-chromium` | 安装依赖 → 按 Playwright 版本缓存 Chromium → 构建 `dist/chrome` → 无头 Playwright e2e                                                |

约定：

- 同一分支连推会取消上一轮（`concurrency.cancel-in-progress`）。
- `permissions: contents: read`，job 超时 15 / 25 分钟。
- CI 不跑 WDIO，因此设置 `CHROMEDRIVER_SKIP_DOWNLOAD=true` 跳过后安装下载；将来加 WDIO job 时在该 job 覆盖为 `false`。
- Playwright 浏览器缓存键使用 `@playwright/test` 自身版本，依赖变动不会无谓失效。
- CI 全程零外网依赖；真实站点冒烟与 WDIO 跨浏览器套件只在本地运行。

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

### 提交检查清单

1. `npm run type-check && npm run type-check:e2e && npm run type-check:wdio`
2. `npm run format:check`
3. `npm run test:unit`
4. `npm run build`
5. `npm run lint:firefox`
6. 需要时本机运行 `npm run test:e2e:wdio`（Chrome + Firefox）
7. 上传 `dist/chrome.zip` 与 `dist/firefox.zip`，按商店要求填写权限用途与隐私声明

## 未完成事项（代码之外）

| 事项                  | 状态   | 说明                                                                                 |
| --------------------- | ------ | ------------------------------------------------------------------------------------ |
| 商店宣传图 440×280    | 待设计 | 需要图像设计工具，非代码可解；素材要求见 [store-listing.md](store-listing.md) 第四节 |
| Chrome Web Store 提交 | 待提交 | 需要账号与人工审核；隐私说明与权限理由已就绪                                         |
| AMO（Firefox）提交    | 待提交 | `web-ext lint` 已通过，可直接上传                                                    |

## 风险与约束

- Firefox 使用 MV2 以避开 MV3 的本地网络访问限制；若 Firefox 未来移除 MV2，需要重新评估 `webRequest` / 代理方案。详见 [02-cross-browser.md](02-cross-browser.md)。
- MAIN 世界注入可被页面检测或绕过，因此安全判定都在后台完成，不依赖钩子生效。详见 [01-architecture.md](01-architecture.md#注入时机与安全)。
- 旧库迁移是跨 origin 读取，必须保持「检测自动、导入显式」与逐条校验，不能改成静默自动导入。
- 浏览器通道没有字节级进度；不要为了补齐进度而轮询 `downloads.search`，那会让 SW 常驻。
