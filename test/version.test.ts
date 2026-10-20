/**
 * 版本号真源单元测试
 *
 * 价值：`package.json` 是扩展版本号的**唯一真源**，manifest 里的 version 由构建期写入。
 * 这里锁住三件事：
 * 1. 商店接受的格式（Chrome 65535 上限 / AMO 9 位上限的交集）；
 * 2. 不合法时**必须抛错**——静默清洗会让 git tag 与商店版本对不上；
 * 3. 模板与 variant 里不能再出现第二个版本号（否则改 package.json 不影响产物）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertExtensionVersion, readExtensionVersion } from '../build/version'
import { chromeVariant, firefoxVariant } from '../manifest/variants'

const root = path.resolve(import.meta.dirname, '..')

test('合法版本：1~4 段整数，含 0.1.0 这类开发版本', () => {
    for (const version of ['1', '1.2', '1.2.3', '1.2.3.4', '0.1.0', '65535.1', '0.0.1']) {
        assert.doesNotThrow(() => assertExtensionVersion(version, 'test'), `应接受 ${version}`)
    }
})

test('预发布后缀被拒绝（不静默削掉，否则 git tag 与商店版本会对不上）', () => {
    for (const version of ['1.0.0-beta.1', '1.0.0+build', '1.0.0-rc1']) {
        assert.throws(() => assertExtensionVersion(version, 'test'), /不符合扩展清单格式/)
    }
    // 错误信息必须给出可行的替代做法
    assert.throws(() => assertExtensionVersion('1.0.0-beta.1', 'test'), /第 4 段|预发布/)
})

test('格式非法：前导零、段数超限、空串、非字符串', () => {
    for (const version of ['2.01', '1.2.3.4.5', '', ' 1.0.0', 'v1.0.0', '1..2']) {
        assert.throws(() => assertExtensionVersion(version, 'test'), Error, `应拒绝 ${JSON.stringify(version)}`)
    }
    for (const version of [undefined, null, 1.2, {}, ['1.0.0']]) {
        assert.throws(() => assertExtensionVersion(version, 'test'), /缺少 version 字段/)
    }
})

test('单段上限取两家交集：65535（Chrome），全零被 Chrome 拒收', () => {
    assert.throws(() => assertExtensionVersion('1.65536.0', 'test'), /超过 65535/)
    assert.throws(() => assertExtensionVersion('0.0.0.0', 'test'), /全为 0/)
    assert.throws(() => assertExtensionVersion('0', 'test'), /全为 0/)
})

test('仓库的 package.json 能被读出且通过校验', async () => {
    const raw = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
    assert.equal(await readExtensionVersion(root), raw.version)
})

test('读取失败时报出具体文件，而不是 undefined', async () => {
    const missing = path.join(os.tmpdir(), 'iwara-assistant-no-such-dir')
    await assert.rejects(() => readExtensionVersion(missing), /package\.json/)
})

test('单真源守卫：manifest 模板与两个 variant 都不携带 version', async () => {
    const base = JSON.parse(await fs.readFile(path.join(root, 'manifest', 'manifest.base.json'), 'utf8')) as Record<string, unknown>
    assert.equal('version' in base, false, 'manifest.base.json 不应有 version——它会被 package.json 覆盖，留着就是第二个真源')
    assert.equal('version' in chromeVariant.extra, false)
    assert.equal('version' in firefoxVariant.extra, false)
})
