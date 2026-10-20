/**
 * 迁移包的形态识别与流式解析（`shared/migrationStream`）。
 *
 * 这里守的是「不能误判」：旧脚本的「导出配置」是**裸配置对象**（GM_setClipboard），
 * 本扩展导出的是**完整迁移包**；把裸配置当包会丢配置，把包当配置会丢四表，
 * 把无关 JSON 当配置则会被 zod 填成默认值（等于重置用户配置）。
 *
 * 另外守「流式成立」：同一份文本无论被切成多大的块（甚至一次一个字符），
 * 解析结果必须一致——否则大文件在块边界上会静默丢记录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLanguage } from '../src/shared/i18n'
import { unknownConfigKeys } from '../src/shared/migrationPayload'
import type { MigrationPayloadShape } from '../src/shared/migrationPayload'
import { scanMigrationJson } from '../src/shared/migrationStream'

// 错误文案走 i18n 字典；本文件断言的是中文版本，显式固定语言（否则跟随运行环境的系统语言）
setLanguage('zh')

interface Collected {
    shape?: MigrationPayloadShape
    config?: Record<string, unknown>
    records: Record<string, unknown[]>
    ignoredKeys: string[]
}

async function* toChunks(text: string, chunkSize: number): AsyncGenerator<string> {
    if (chunkSize <= 0) {
        yield text
        return
    }
    for (let offset = 0; offset < text.length; offset += chunkSize) yield text.slice(offset, offset + chunkSize)
}

/** 把事件流收敛成便于断言的结构（生产代码不会这么做——那等于把整表攒回内存） */
async function collect(text: string, chunkSize = 0): Promise<Collected> {
    const collected: Collected = { records: {}, ignoredKeys: [] }
    for await (const event of scanMigrationJson(toChunks(text, chunkSize))) {
        if (event.type === 'shape') collected.shape = event.shape
        else if (event.type === 'ignoredKey') collected.ignoredKeys.push(event.key)
        else if (event.type === 'config') collected.config = event.value
        else {
            const rows = (collected.records[event.store] ??= [])
            rows.push(event.value)
        }
    }
    return collected
}

test('完整迁移包：保留 config 与四表，记录被忽略的顶层键', async () => {
    const collected = await collect(
        JSON.stringify({
            config: { downloadPath: '/x' },
            videos: [{ ID: 'v1', Type: 'full' }],
            follows: [{ id: 'u1' }],
            friends: [],
            idmap: [{ ID: 'v1', href: 'https://www.iwara.tv/video/v1' }],
            downloadQueue: [{ id: 'runtime-state' }]
        })
    )
    assert.equal(collected.shape, 'package')
    assert.deepEqual(collected.config, { downloadPath: '/x' })
    assert.deepEqual(collected.records.videos, [{ ID: 'v1', Type: 'full' }])
    assert.deepEqual(collected.records.follows, [{ id: 'u1' }])
    // 空表不产出任何 record 事件（流式解析只有「记录」没有「数组」），上层据此不显示 0/0 行
    assert.equal(collected.records.friends, undefined)
    assert.deepEqual(collected.records.idmap, [{ ID: 'v1', href: 'https://www.iwara.tv/video/v1' }])
    assert.deepEqual(collected.ignoredKeys, ['downloadQueue'])
})

test('只有部分表的迁移包也算 package（不要求 config）', async () => {
    const collected = await collect(JSON.stringify({ videos: [{ ID: 'v1', Type: 'cache' }] }))
    assert.equal(collected.shape, 'package')
    assert.equal(collected.config, undefined)
    assert.equal(collected.records.videos?.length, 1)
})

test('裸配置对象（油猴脚本「导出配置」剪贴板内容）识别为 config', async () => {
    const collected = await collect(JSON.stringify({ downloadPath: '/Iwara/%#TITLE#%.mp4', filterLikedVideos: true }))
    assert.equal(collected.shape, 'config')
    assert.deepEqual(collected.config, { downloadPath: '/Iwara/%#TITLE#%.mp4', filterLikedVideos: true })
    assert.equal(collected.records.videos, undefined)
})

test('未知键出现在包键之前：仍判为 package，且这些键如实上报', async () => {
    const collected = await collect(JSON.stringify({ downloadQueue: [1, 2], videos: [{ ID: 'v1' }] }))
    assert.equal(collected.shape, 'package')
    assert.deepEqual(collected.ignoredKeys, ['downloadQueue'])
    assert.equal(collected.records.videos?.length, 1)
})

test('无关 JSON 必须报错，不能当成空配置去覆盖现有配置', async () => {
    await assert.rejects(collect(JSON.stringify({ hello: 'world' })), /无法识别的 JSON/)
    await assert.rejects(collect(JSON.stringify({ a: 1, b: 2 })), /无法识别的 JSON/)
})

test('空对象、数组、基本类型都报错', async () => {
    await assert.rejects(collect('{}'), /空的/)
    await assert.rejects(collect('[]'), /JSON 对象/)
    await assert.rejects(collect('"config"'), /JSON 对象/)
    await assert.rejects(collect('null'), /JSON 对象/)
})

test('结构错误的包报出具体字段（而不是静默忽略）', async () => {
    await assert.rejects(collect(JSON.stringify({ config: 'nope' })), /config 字段必须是对象/)
    await assert.rejects(collect(JSON.stringify({ videos: 'nope' })), /字段 videos 必须是数组/)
    await assert.rejects(collect(JSON.stringify({ config: null })), /没有可导入的内容/)
})

test('容忍 BOM/首尾空白，非法 JSON 给出明确错误', async () => {
    const collected = await collect('\uFEFF  {"filterLikedVideos": true}\n')
    assert.equal(collected.shape, 'config')
    await assert.rejects(collect('   '), /空的/)
    await assert.rejects(collect('{"a":}'), /不是合法 JSON/)
})

test('流式等价：任意块大小（含 1 字符）解析结果与整串一致', async () => {
    const text = JSON.stringify(
        {
            config: { downloadPath: '/Iwara/%#AUTHOR#%/%#TITLE#%.mp4', note: '引号 " 反斜杠 \\ 换行 \n 括号 {}[] 逗号 ,', nested: { a: [1, 2, { b: null }] } },
            videos: [
                { ID: 'v1', Title: '含 "引号" 与 \\ 反斜杠', RAW: { deep: [[1], [2, { x: '}' }]] } },
                { ID: 'v2', Title: '中文 🎬', UploadTime: 1700000000000 },
                { ID: 'v3', Number: -1.5e-7 }
            ],
            follows: [{ id: 'u1' }],
            friends: [],
            idmap: [{ ID: 'v1', href: 'https://www.iwara.tv/video/v1' }]
        },
        null,
        2
    )

    const whole = await collect(text)
    for (const chunkSize of [1, 2, 3, 7, 13, 64, 1024]) {
        assert.deepEqual(await collect(text, chunkSize), whole, `chunkSize=${chunkSize}`)
    }
})

test('跨块边界的字面量（true/false/null/数字）不会被切断', async () => {
    const text = '{"videos":[{"ID":"v1","Flag":true,"Maybe":null,"Score":123.456}],"extra":false}'
    for (const chunkSize of [1, 2, 5]) {
        const collected = await collect(text, chunkSize)
        assert.deepEqual(collected.records.videos, [{ ID: 'v1', Flag: true, Maybe: null, Score: 123.456 }])
        assert.deepEqual(collected.ignoredKeys, ['extra'])
    }
})

test('多行/无缩进两种排版都接受（旧导出与新导出都能读）', async () => {
    const payload = { config: { filterLikedVideos: false }, videos: [{ ID: 'v1' }] }
    const pretty = await collect(JSON.stringify(payload, null, 4))
    const compact = await collect(JSON.stringify(payload))
    assert.deepEqual(pretty, compact)
})

test('unknownConfigKeys 只报 schema 之外的键', () => {
    assert.deepEqual(unknownConfigKeys({ downloadPath: '/x', authorization: 'token', whatever: 1 }), ['authorization', 'whatever'])
})
