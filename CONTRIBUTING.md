# 参与贡献

感谢你愿意参与。这是一个以「行为边界」为核心的浏览器扩展项目：很多看起来该通用的写法在这里是有代价的，所以**动手前先读 [AGENTS.md](AGENTS.md)**——门禁清单、架构铁律、目录归位、代码约定与一批平台事实都在那里。本文只讲流程。

## 环境

- **Node.js ≥ 20.11**（`package.json` 的 `engines`）。
- `npm install` 会顺带启用仓库自带的 Git 钩子（`prepare` → `.githooks/install.mjs`）。只读代码不开发的话可以 `git config --unset core.hooksPath` 关掉。
- 想跑跨浏览器 e2e 需要本机装有 Chrome 与 Firefox；只跑单测与 Playwright 不需要额外安装。

```bash
npm install
npm run dev:chrome     # watch 模式；html/css/manifest 改动需重跑
```

## 门禁：提交前必须全绿

CI 的 `verify` job 就是这六步，顺序也一致；`pre-push` 钩子会在本地按同一顺序再跑一遍：

```bash
npm run type-check        # 扩展源码 + 单测
npm run type-check:e2e    # Playwright specs（独立 tsconfig）
npm run type-check:wdio   # WDIO specs（独立 tsconfig）
npm run test:unit         # node:test + tsx
npm run build             # Chrome + Firefox 双目标编译与打包
npm run lint:firefox      # web-ext lint，目标 0 error / 0 notice
```

本地还能跑的（CI 不跑，提交前建议至少跑一次相关的那部分）：

```bash
npm run test:e2e              # Playwright，直载 dist/chrome
npm run test:e2e:wdio         # Chrome + Firefox 双宿主
npm run format:check          # prettier（printWidth 9999 / tab 4 / 无分号 / 单引号 / CRLF）
npm run test:firefox:smoke    # web-ext run 装载冒烟
```

**三套 `tsc` 都要跑**：只跑 `type-check` 会漏掉 `e2e/` 与 `e2e/wdio/`，它们各有独立 tsconfig。命令输出不要过滤（`| tail`、`Select-Object -First`），失败原因经常就在被截掉的那部分。

## 提交消息

`commit-msg` 钩子校验 `<type>: <说明>`（也接受 `feat(scope): …` 与破坏性变更 `feat!: …`）。

| 允许的 type                                                                                            | 场景                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `feat` / `fix` / `perf` / `refactor` / `style` / `test` / `docs` / `chore` / `ci` / `build` / `revert` | 与常规 Conventional Commits 一致 |

说明部分写清**为什么**：这个仓库的历史里，「因为平台行为如此」的提交比「按惯例如此」的提交更容易在后来的审计里被留下。

## PR 流程

1. 从 `main` 拉分支，分支名用小写短横线（如 `fix-aria2-adopt`）。
2. 改动尽量单一主题；一次 PR 里混入重构与行为变更会让评审无法判断风险。
3. 提交前把上面的门禁跑通，并在 PR 描述里写清：改了什么、为什么这样改、怎么验证的。
4. **用户可见文案要同步三份字典**（`src/shared/locales/{en,zh,ja}.json`），键必须完全一致，`test/i18n.test.ts` 会守。
5. **页面 UI 契约**（class / `data-testid` / 结构）变动时，同步 Playwright 与 WDIO 里对应的选择器与断言。
6. 版本号变更要连带 `GuideTab` 的 `RELEASES` 与三语 `guide.changelog.vXXXX`，否则「引导页」用例会红。

完整的「改了什么还要改什么」清单在 [AGENTS.md](AGENTS.md) 第 8 节。重构还要清尾：删掉旧类型、旧常量、旧选择器、旧字典键，别只改主路径。

## 测试怎么写

- 纯函数与状态机的单测放 `test/<被测模块同名>.test.ts`。
- 源级守卫（`test/sourceGuard.ts` 的 `readSource`）用来守「某段代码不该再出现」这类不变量；**写完必须临时改坏一次确认它会红**，否则断言可能永真。
- e2e 不要假设库是空的：Playwright 的 persistent profile 跨 spec 复用。只断言本次播种的子集，或用自洽性质（如分页计数之和等于读取条数）。

## 报告 Bug

请用 issue 模板填写，并附上：扩展版本、浏览器与版本、下载通道、任务队列里的原始错误码/报文、调试模式下的控制台片段（抓日志方式见 [Wiki：故障排查](https://github.com/dawn-lc/IwaraAssistant/wiki/故障排查#10-抓日志与导出数据)）。**安全漏洞不要开公开 issue**，走 [SECURITY.md](SECURITY.md)。

## 许可

提交即表示你同意以本仓库的 [Apache-2.0](LICENSE) 许可证分发你的贡献。
