# GitHub Wiki 源稿

这里的 13 篇（Home + 12 个专题）是 **[项目 Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki) 的源稿**，面向使用者（安装、Chromium 手动加载、通道配置、路径变量、队列语义、私有视频、迁移、同步、调试、故障排查、常见问题）。技术实现只写在 `docs/01`~`docs/09`，两处不重复同一层内容：**用法查 Wiki，实现查 docs/**。技术实现仍然只写在 `docs/01`~`docs/10`，两处不重复同一层内容：**用法查 Wiki，实现查 docs/。**

为什么源稿放在仓库里：Wiki 是独立的 git 子仓库（`IwaraAssistant.wiki.git`），只有它才有版本历史；仓库里留一份可评审、可 PR、能和代码同一次提交里改的副本，避免「文档改了代码没改」这类漂移。

## 发布到 Wiki

```bash
git clone https://github.com/dawn-lc/IwaraAssistant.wiki.git temp/wiki-remote
cp docs/wiki/*.md temp/wiki-remote/ && rm -f temp/wiki-remote/README.md
git -C temp/wiki-remote add -A
git -C temp/wiki-remote commit -m 'docs: 同步 docs/wiki 源稿'
git -C temp/wiki-remote push
```

只改了单页时也可以直接在子仓库里改那一页再推。页面之间用 `[[页面名]]` 互链，文件名（去掉 `.md`）就是页面标题；`README.md` 不会被发布（只给仓库读者看）。
