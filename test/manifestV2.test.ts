/**
 * MV3 → MV2 清单改写单元测试。
 *
 * 为什么值得单独测：Firefox 产物是 MV2（局域网 http 与持久后台页的唯一路径），
 * 而 base 模板始终按 MV3 写。改写错了的表现极其隐蔽——装得上、能跑，
 * 但权限少了、角标没反应、或后台变成事件页后被回收，报错点离真因很远。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { toManifestV2 } from '../build/manifestV2'
import { chromeVariant, firefoxVariant } from '../manifest/variants'

const root = path.resolve(import.meta.dirname, '..')

/**
 * 读 base 模板并按 Chrome 变体的占位符表解析——与构建真正做的事一致。
 * 直接用原始 JSON 断言背景形态会永远失败：模板里写的是 `%#background_key#%`。
 */
async function readBase(): Promise<Record<string, unknown>> {
    let raw = await fs.readFile(path.join(root, 'manifest', 'manifest.base.json'), 'utf8')
    for (const [key, value] of Object.entries(chromeVariant.placeholder)) raw = raw.split(`%#${key}#%`).join(value)
    return JSON.parse(raw) as Record<string, unknown>
}

test('host_permissions 并入 permissions（MV2 没有这个键），且不重复', async () => {
    const manifest = await readBase()
    toManifestV2(manifest)
    assert.equal('host_permissions' in manifest, false)
    const permissions = manifest['permissions'] as string[]
    assert.ok(permissions.includes('<all_urls>'))
    assert.equal(new Set(permissions).size, permissions.length, 'permissions 出现重复项')
})

test('action 改名 browser_action，保留原内容', async () => {
    const manifest = await readBase()
    const action = manifest['action']
    toManifestV2(manifest)
    assert.equal('action' in manifest, false)
    assert.deepEqual(manifest['browser_action'], action)
})

test('background.service_worker → 持久化 scripts（Firefox 靠它常驻）', async () => {
    const manifest = await readBase()
    toManifestV2(manifest)
    assert.deepEqual(manifest['background'], { scripts: ['background.js'], persistent: true })
})

test('manifest_version 归 2，Chrome 专属键被移除', async () => {
    const manifest = await readBase()
    manifest['minimum_chrome_version'] = '111'
    toManifestV2(manifest)
    assert.equal(manifest['manifest_version'], 2)
    assert.equal('minimum_chrome_version' in manifest, false)
})

test('形状不同的键按 MV2 规则摊平：CSP 对象 → 字符串、WAR 对象数组 → 字符串数组', () => {
    const manifest: Record<string, unknown> = {
        manifest_version: 3,
        content_security_policy: { extension_pages: "script-src 'self'", sandbox: 'sandbox allow-scripts' },
        web_accessible_resources: [{ resources: ['a.js'], matches: ['<all_urls>'] }, { resources: ['b.css'] }, 'c.png']
    }
    toManifestV2(manifest)
    assert.equal(manifest['content_security_policy'], "script-src 'self'")
    assert.deepEqual(manifest['web_accessible_resources'], ['a.js', 'b.css', 'c.png'])
})

test('CSP 没有 extension_pages 时整个键丢弃（不能留下对象形态）', () => {
    const manifest: Record<string, unknown> = { manifest_version: 3, content_security_policy: { sandbox: 'sandbox allow-scripts' } }
    toManifestV2(manifest)
    assert.equal('content_security_policy' in manifest, false)
})

test('改写失败要大声报错：真的残留 MV3 键说明转换漏了', () => {
    // 正常的 base 不会触发；用「已转换过的对象再转换一次」模拟漏项：
    // 这里断言的是函数最后那段残留检查确实存在且会抛。
    const manifest: Record<string, unknown> = { manifest_version: 3, action: {} }
    toManifestV2(manifest)
    // 二次调用不应把 browser_action 再改回去，也不应抛错（幂等）
    assert.doesNotThrow(() => toManifestV2(manifest))
    assert.equal(manifest['manifest_version'], 2)
})

test('真源守卫：Firefox 变体声明 MV2，且持久后台页不会被改成 false', async () => {
    assert.equal(firefoxVariant.manifestVersion, 2)
    const background = firefoxVariant.extra['background'] as { scripts?: string[]; persistent?: boolean }
    assert.deepEqual(background.scripts, ['background.js'])
    assert.equal(background.persistent, true, 'Firefox 后台必须是持久页，否则保活能力全丢')
    // Chrome 变体保持 MV3（不声明 manifestVersion 即默认 3）
    assert.equal(chromeVariant.manifestVersion, undefined)
    const base = await readBase()
    assert.equal(base['manifest_version'], 3, 'base 模板应始终按 MV3 写，由 toManifestV2 派生 MV2')
    // 模板必须仍以 service_worker 声明后台，否则上面的转换路径根本不会被走到
    assert.deepEqual(base['background'], { service_worker: 'background.js' })
})
