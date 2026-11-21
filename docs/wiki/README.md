# GitHub Wiki 源稿

这里的 11 篇是 **[项目 Wiki](https://github.com/dawn-lc/IwaraAssistant/wiki) 的源稿**，面向使用者（安装、通道配置、路径变量、队列语义、私有视频、迁移、同步、调试、常见问题）。技术实现仍然只写在 `docs/01`~`docs/10`，两处不重复同一层内容。

为什么源稿放在仓库里：Wiki 是独立的 git 子仓库（`IwaraAssistant.wiki.git`），只有它才有版本历史；仓库里留一份可评审、可 PR、可和代码同一次提交里改的副本，避免「文档改了代码没改」这类漂移。

## 发布到 Wiki

首次需要有人在网页上点一次「Create the first page」——GitHub 只在第一次保存首页时才创建 wiki 子仓库，这一步没有 API。之后：

```bash
git clone https://github.com/dawn-lc/IwaraAssistant.wiki.git ../ia-wiki
cp docs/wiki/*.md ../ia-wiki/
git -C ../ia-wiki add -A
git -C ../ia-wiki commit -m 'docs: 同步 docs/wiki 源稿'
git -C ../ia-wiki push
```

`README.md` 里的 Wiki 链接指向发布后的地址；页面之间用 `[[页面名]]` 互链，文件名（去掉 `.md`）就是页面标题。
