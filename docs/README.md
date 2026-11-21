# docs 目录（开发文档）

这里只放**面向开发与维护**的文档。面向使用者的内容（安装、通道配置、路径变量、队列语义、迁移、故障排查、FAQ）全部在 [项目 Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki)，源稿在 [docs/wiki/](wiki/)——**用法查 Wiki，实现查 docs/**。

| 文档                                                   | 内容                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [01-architecture.md](01-architecture.md)               | 设计原则、运行时上下文、源码目录、注入时机与安全、UI 技术栈、状态与权限 |
| [02-cross-browser.md](02-cross-browser.md)             | `browser` 命名空间策略、shim、浏览器差异矩阵与 Firefox 专项             |
| [03-manifest.md](03-manifest.md)                       | 双 manifest 派生、版本号真源、权限清单、CSP 与打包                      |
| [04-messaging.md](04-messaging.md)                     | 消息协议、全兼容监听器、MAIN ⇄ ISOLATED 桥、后台路由                    |
| [05-features.md](05-features.md)                       | 功能与行为边界的权威清单（含「有意不做」的取舍）                        |
| [06-testing-and-release.md](06-testing-and-release.md) | 开发命令、测试分层、CI、Git 钩子、发布流程与未完成事项                  |
| [08-aria2-flow.md](08-aria2-flow.md)                   | aria2 任务管理逻辑图：三条入口、扫描对账、状态映射、失败与取消时序      |
| [09-debug-bridge.md](09-debug-bridge.md)               | 调试通道：扩展主动连本机调试服务，快照、日志环、白名单命令              |
| [agent-notes.md](agent-notes.md)                       | AGENTS.md 每条规则背后的事故与实测记录                                  |
| [store-listing.md](store-listing.md)                   | AMO 上架素材与文案、Chrome Web Store 拒绝记录                           |
| [wiki/](wiki/)                                         | Wiki 源稿（面向使用者，发布到 GitHub Wiki）                             |

编号刻意从 01 跳到 09 且缺 07 / 10：那两篇（Chromium 手动安装、故障排查）已迁到 Wiki，编号保留空位以免外部链接按编号指错文档。
