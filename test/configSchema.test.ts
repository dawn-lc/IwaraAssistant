/**
 * 配置 schema 单元测试
 *
 * 价值：`configSchema` 是**存量油猴数据迁移**与「脏数据回落」的唯一关口。
 * 这里锁定两个行为：缺省字段自动补默认值、非法值整体回落默认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, DownloadType, configSchema } from '../src/shared/configSchema'

test('空对象解析出完整默认配置', () => {
    const config = configSchema.parse({})
    // 默认浏览器内建下载：唯一既有回传通道又零外部依赖的通道
    assert.equal(config.downloadType, DownloadType.Browser)
    assert.equal(config.autoInjectCheckbox, true)
    assert.equal(config.pathTitleMaxLength, 72)
    // 新装默认跟随浏览器语言；显式选择才写 en/ja/zh
    assert.equal(config.language, 'auto')
})

test('部分字段覆盖时其余字段仍有默认值', () => {
    const config = configSchema.parse({ autoLike: true, pathTitleMaxLength: 40 })
    assert.equal(config.autoLike, true)
    assert.equal(config.pathTitleMaxLength, 40)
    assert.equal(config.autoFollow, false)
})

test('非法值被拒绝（而不是静默写入）', () => {
    const result = configSchema.safeParse({ language: 'klingon' })
    assert.equal(result.success, false)
})

test('未知字段被剥离（迁移导入带脏字段时不污染配置）', () => {
    const config = configSchema.parse({ autoLike: true, legacyUnknown: 'x' }) as Record<string, unknown>
    assert.equal('legacyUnknown' in config, false)
})

test('DEFAULT_CONFIG 与 parse({}) 一致', () => {
    assert.deepEqual(DEFAULT_CONFIG, configSchema.parse({}))
})

test('同时下载数默认 3，且不接受越界值（0 / 11 直接判非法）', () => {
    assert.equal(configSchema.parse({}).browserConcurrentDownloads, 3)
    assert.equal(configSchema.safeParse({ browserConcurrentDownloads: 0 }).success, false)
    assert.equal(configSchema.safeParse({ browserConcurrentDownloads: 11 }).success, false)
    assert.equal(configSchema.safeParse({ browserConcurrentDownloads: 2.5 }).success, false)
})

test('新增 isDebug 默认关闭', () => {
    assert.equal(configSchema.parse({}).isDebug, false)
    assert.equal(DEFAULT_CONFIG.isDebug, false)
})

test('关注扩展作者默认开启（与源项目一致）', () => {
    // 该动作在后台是一次性的（完成后写 mark），默认开启的成本只是首次启动的两次请求；
    // 若有人把它改回 false，行为会与源项目不一致，用户也要手动去开。
    assert.equal(DEFAULT_CONFIG.promoteScriptAuthor, true)
    assert.equal(configSchema.parse({}).promoteScriptAuthor, true)
    // 显式关闭仍然有效（用户已存的 false 不能被默认值覆盖）
    assert.equal(configSchema.parse({ promoteScriptAuthor: false }).promoteScriptAuthor, false)
})

test('好友审批条件默认为空（不能默认「无条件批准」）', () => {
    // 曾经默认 `['always']`：新装用户点一次「立即审批全部请求」就会通过所有好友请求，
    // 而且是不可撤销的社交动作。默认必须是「什么都没选」，由界面提示先勾条件。
    assert.deepEqual(DEFAULT_CONFIG.friendRequestApprovalConditions, [])
    assert.deepEqual(configSchema.parse({}).friendRequestApprovalConditions, [])
    // 用户已存的显式选择不能被默认值抹掉
    assert.deepEqual(configSchema.parse({ friendRequestApprovalConditions: ['followedBy'] }).friendRequestApprovalConditions, ['followedBy'])
})

test('保持后台活跃默认关闭（Chrome 也没有官方常驻能力）', () => {
    assert.equal(DEFAULT_CONFIG.keepBackgroundAlive, false)
    assert.equal(configSchema.parse({ keepBackgroundAlive: true }).keepBackgroundAlive, true)
})
