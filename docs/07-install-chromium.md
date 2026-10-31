# 07 Chromium 系手动安装指南

本扩展**无法从 Chrome 应用商店安装**（原因见 [README「为什么不在商店里」](../README.md#为什么不在商店里)），Chromium 系浏览器只能手动加载。这份文档给出从零到能用的完整步骤，含更新、回滚与常见故障。

Firefox 用户不需要本文：已在 [AMO 上架](https://addons.mozilla.org/firefox/addon/iwara-assistant/)，直接装。

手动加载（sideload，"加载已解压的扩展程序"）在功能上与商店安装**完全一致**：同一个 `dist/chrome` 目录，全站权限、下载通道、后台任务、系统通知都正常。

## 适用浏览器

| 浏览器            | 扩展管理页            | 能否加载未打包扩展 |
| ----------------- | --------------------- | ------------------ |
| Chrome / Chromium | `chrome://extensions` | ✅                 |
| Edge              | `edge://extensions`   | ✅                 |
| Brave             | `chrome://extensions` | ✅                 |
| Vivaldi           | `chrome://extensions` | ✅                 |
| Opera             | `opera://extensions`  | ✅                 |
| Arc               | `arc://extensions`    | ✅                 |

最低版本 **Chrome 111**（manifest 里声明了 `minimum_chrome_version: 111`，低于此版本的加载器会直接拒绝）。

## 第一步：拿到 `dist/chrome`

需要的不是 `.crx`，而是一个**目录**，目录里能直接看到 `manifest.json`。两条路径任选其一。

### 路径 A：从源码构建（推荐）

适合想跟进更新、愿意装 Node 的人。构建脚本不需要联网编译工具链，只是一次 esbuild。

```bash
git clone https://github.com/dawn-lc/IwaraAssistant.git
cd IwaraAssistant
npm install          # Node >= 20.11
npm run build:chrome # 只构建 Chrome 产物 → dist/chrome
```

- `npm run build:chrome` 只产出 `dist/chrome`，比 `npm run build` 快，且不会顺带构建 Firefox、不会打 zip。
- `npm install` 会触发仓库的 `prepare` 脚本，把 git 钩子指向 `.githooks`。**只安装不开发的话可以忽略**，它不影响扩展运行；想彻底关掉执行 `git config --unset core.hooksPath`。
- Windows 上装完 Node 后如果 `npm` 提示无法识别，重开一个终端（PATH 需要刷新）。

构建成功的标志是最后一行出现 `[build] dist/chrome ready  v<版本号>`。

### 路径 B：直接下载 CI 构建产物

不需要 Node，但**需要 GitHub 账号**（Actions 的产物不登录无法下载），且产物只保留 **14 天**。

1. 打开 <https://github.com/dawn-lc/IwaraAssistant/actions/workflows/ci.yml>。
2. 点最上面一次带绿勾的运行（`main` 分支）。
3. 页面拉到最底部 **Artifacts** 区域，下载 `extension-zips`。
4. 得到 `extension-zips.zip` → 先解压，里面有 `chrome.zip` 与 `firefox.zip`。
5. 再解压 `chrome.zip`，得到一个直接含 `manifest.json` 的文件夹，这就是第一步要的目录。

装了 `gh` 的话一条命令等价：

```bash
gh run download --repo dawn-lc/IwaraAssistant --name extension-zips
```

> 为什么产物只在 Actions 里：仓库不放预编译包，任何人下载的代码都能在仓库里逐行对上（`dist` 不进版本库）。**只从本仓库源码或本仓库 Actions 取产物**，别用第三方转发的 zip / crx——那种包里的 JS 没人对得上源码。

## 第二步：加载扩展

### Chrome / Chromium / Brave / Vivaldi

1. 地址栏输入 `chrome://extensions` 回车。
2. 右上角打开 **开发者模式**（开关变蓝）。
3. 左上角出现三个按钮，点 **加载已解压的扩展程序**。
4. 在文件选择框里定位到 `dist\chrome`（或路径 B 解压出来的文件夹），**选中这个文件夹本身**，点「选择文件夹」。

选对目录的判据：进入该目录应该**直接**看到 `manifest.json`、`background.js`、`icons` 等。如果目录里只有一个同名子文件夹，说明选高了一层，进去再选。

### Edge

1. 地址栏输入 `edge://extensions`。
2. 左侧（或页面底部）打开 **开发人员模式**。
3. 点 **加载解压缩的扩展**，选同一个目录。

### Opera

1. 地址栏输入 `opera://extensions`。
2. 打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选同一个目录。

加载成功后扩展卡片上会显示版本号（如 `0.1.32`），且**没有**红色「错误」按钮。

## 第三步：确认能用

1. **固定到工具栏**（可选但强烈建议）：点工具栏的拼图图标 → 在「Iwara Assistant」右侧点图钉。后台任务进度、失败重试都要从这里进任务队列。
2. 打开 <https://www.iwara.tv/>。页面**右侧中部**会出现一条悬浮菜单，移入展开，能看到「下载当前视频」或「开关选择框」。
3. 打开任一视频详情页，菜单里应有「下载当前视频」。点它，扩展会弹系统通知并在任务队列里生成一条记录。

三条都对上就装好了。菜单没出现时按顺序排查：

| 检查项             | 做法                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| 页面是否已刷新     | 装扩展前就打开的标签页不会自动注入，按 `F5` 重载                                   |
| 扩展是否启用       | `chrome://extensions` 里卡片右下角的开关是蓝色                                     |
| 是否被别的扩展挡住 | 关掉其他改页面的扩展（尤其油猴脚本管理器里的旧版 iwara 脚本）再试                  |
| 是否有报错         | 卡片上有红色的「错误」按钮就点开看堆栈；没有则点「服务工作进程」链接看后台是否在跑 |
| 旧脚本冲突         | 装过旧版油猴脚本的话，先禁用它再装本扩展，两者同时开会重复注入                     |

## 日常更新

源码路径：

```bash
git pull
npm run build:chrome
```

然后回到 `chrome://extensions`，点该扩展卡片上的**刷新**图标（圆形箭头）。**必须点这一步**，否则浏览器仍在跑旧的 `background.js`。

路径 B：重新下载 `extension-zips` → 解压覆盖到**同一个文件夹** → 同样点刷新图标。

> 构建会先清空 `dist/chrome`。如果扩展正处于启用状态，Chrome 在清空瞬间会把卡片标成「已损坏」，属正常现象——构建完点刷新即可，期间不影响已打开页面的行为。

## 数据与扩展 ID

未打包扩展的 ID 由**加载目录的绝对路径**决定。所以：

- **保持同一个目录 + 同一次浏览器配置** → 更新后配置、任务队列、视频库（IndexedDB）全部保留，无需重新登录或迁移。
- **换了目录、换了电脑、换了浏览器** → 新 ID，等于全新安装，旧数据不会跟过来。要搬数据用选项页「迁移」里的导出/导入迁移包（完整备份，含视频库）。
- **先在旧环境导出再换路径**，否则旧数据只能靠手动找浏览器 profile 目录捞，很麻烦。

卸载扩展（点卡片上的「移除」）会**同时删除**该扩展的存储与 IndexedDB。想留数据就先导出。

## 卸载与回滚

- 卸载：`chrome://extensions` → 卡片「移除」。
- 回滚到旧版本：`git checkout <旧 tag 或 commit>` → `npm run build:chrome` → 点刷新。配置 schema 向前兼容（缺字段补默认值、未知字段忽略），回滚一般不会损坏数据；但**新版写过的字段在旧版里会被忽略**，回滚后看到的是旧版认知里的值。

## 常见问题

**浏览器提示这个扩展「不受信任」/不来自商店，或者建议停用开发者模式扩展**
Chrome 对侧载扩展的固定标记与提示，无法关闭，忽略即可。它不代表扩展有问题，也不影响任何功能。

**报「清单文件缺失或不可读取」**
选错目录了。要选的是**直接包含** `manifest.json` 的那一层，不是它的父目录，也不是 zip 文件本身。

**报「无法加载扩展程序，因为它不是有效目录」或加载后立刻变「已损坏」**
通常是解压不完整，或把 `dist/chrome.zip` 当目录选了。重新解压一遍，确认目录里有 `manifest.json` + `background.js` + `icons/`。

**扩展卡片还在，但页面里不出菜单**
先刷新页面。仍不出就点开卡片的「服务工作进程」看后台有没有异常退出；后台挂了通常伴随一条红色「错误」，内容会是具体堆栈。

**能不能装成 `.crx`**
不要。Chrome 稳定版已不再支持拖入 crx 安装（除企业策略），而且 crx 里的代码无法和仓库源码逐行对照。用「加载已解压的扩展程序」。

**公司/学校账号装不上**
组织策略可能禁止加载未打包扩展（`ExtensionInstallBlocklist` / 强制商店来源）。这个改不了，换个人浏览器配置，或改用 Firefox（[AMO 已上架](https://addons.mozilla.org/firefox/addon/iwara-assistant/)，策略限制同样可能存在）。

**换台电脑要重装一遍吗**
要，但只需重复「第一步 + 第二步」。想同步数据就在旧机器导出迁移包、新机器导入。

**这个扩展会不会偷偷干别的**
不会。全部 JS 都打包在包内，没有远程代码、没有 `eval`、不含任何统计上报；`<all_urls>` 的两处用途写在 [README 的权限说明](../README.md#权限说明) 里。担心的话直接读 `src/`，构建只是把这些 TS 编译成 IIFE。

## 安全与信任边界

手动安装把「谁来保证代码可信」的责任交给了你，所以这里明确两点：

1. **来源**：只用本仓库源码构建，或本仓库 Actions 产出的 `extension-zips`。别人转发的包无法验证。
2. **可验证性**：`npm run build:chrome` 是确定性的，同一 commit 构建出的产物可以互相比较；想核对某个行为，直接看 `src/background/` 与 `src/content/`。

Firefox 不需要看本文：它已在 [AMO 上架](https://addons.mozilla.org/firefox/addon/iwara-assistant/)，直接安装即可，自动更新；只有想跑仓库最新代码时才走 `about:debugging#/runtime/this-firefox` 临时载入 `dist/firefox/manifest.json`。上架状态见 [06-testing-and-release.md](06-testing-and-release.md#未完成事项代码之外)。
