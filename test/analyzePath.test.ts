/**
 * 路径分析单元测试（原 core/path.ts 的行为契约）
 *
 * 为什么这些必须有单测：路径处理是**纯函数**、故障面最广（Windows 盘符、
 * 相对路径、'.'/'..' 越界、非法字符），而 e2e 只能在真实浏览器里跑、
 * 不能覆盖这些边界。改一行正则就可能静默破坏所有下载路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLanguage } from '../src/shared/i18n'
import { analyzePath, toDownloadFilename } from '../src/shared/analyzePath'

// 错误文案走 i18n 字典；本文件断言的是中文版本，显式固定语言（否则跟随运行环境的系统语言）
setLanguage('zh')

test('Windows 绝对路径：目录 / 文件名 / 扩展名拆分', () => {
    const parsed = analyzePath('D:\\Downloads\\Iwara\\Artist\\Title[abc].mp4')
    assert.equal(parsed.type, 'Windows')
    assert.equal(parsed.fullPath, 'D:\\Downloads\\Iwara\\Artist\\Title[abc].mp4')
    // directory 去掉文件名后自然带尾分隔符（源项目 extractDirectory 同义）
    assert.equal(parsed.directory, 'D:\\Downloads\\Iwara\\Artist\\')
    assert.equal(parsed.fullName, 'Title[abc].mp4')
    assert.equal(parsed.baseName, 'Title[abc]')
    assert.equal(parsed.extension, 'mp4')
})

test('Unix 绝对路径必须保留前导 /（历史回归：曾被渲染成相对路径）', () => {
    const parsed = analyzePath('/home/user/videos/a.webm')
    assert.equal(parsed.type, 'Unix')
    assert.equal(parsed.fullPath, '/home/user/videos/a.webm')
    assert.equal(parsed.directory, '/home/user/videos/')
    assert.equal(parsed.fullName, 'a.webm')
    assert.equal(parsed.extension, 'webm')
})

test('Unix 根下单个文件：directory 为 /', () => {
    const parsed = analyzePath('/a.mp4')
    assert.equal(parsed.fullPath, '/a.mp4')
    assert.equal(parsed.directory, '/')
})

test('相对路径', () => {
    const parsed = analyzePath('Iwara/Author/a.mp4')
    assert.equal(parsed.type, 'Relative')
    assert.equal(parsed.fullName, 'a.mp4')
})

test("'.' 与 '..' 会被归一化", () => {
    assert.equal(analyzePath('a/./b/../c.mp4').fullPath, 'a/c.mp4')
})

test("'..' 越界抛错（不能逃出根）", () => {
    assert.throws(() => analyzePath('../escape.mp4'), /越界|上级/)
})

test('空路径与 UNC 路径被拒绝', () => {
    assert.throws(() => analyzePath(''), /不能为空/)
    assert.throws(() => analyzePath('\\\\server\\share\\a.mp4'), /UNC/)
})

test('Windows 段内非法字符被拒绝', () => {
    assert.throws(() => analyzePath('D:\\a<b\\c.mp4'), /非法字符/)
})

test('toDownloadFilename：保留完整子目录（两宿主都支持）', () => {
    // Chrome 一直支持；Firefox 自 51 起支持子目录（Bugzilla 1280044 已 FIXED）
    assert.equal(toDownloadFilename(analyzePath('/Iwara/Author/a.mp4')), 'Iwara/Author/a.mp4')
    assert.equal(toDownloadFilename(analyzePath('Relative/Sub/a.mp4')), 'Relative/Sub/a.mp4')
})

test('Windows 盘符路径剥掉盘符但保留子目录', () => {
    assert.equal(toDownloadFilename(analyzePath('D:\\Iwara\\Author\\a.mp4')), 'Iwara/Author/a.mp4')
})
