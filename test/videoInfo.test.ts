/**
 * VideoInfo 完整度择优（`shared/videoInfo.ts`）。
 *
 * 用在「库内缓存」与「刚解析出来」两份数据之间：解析有时只拿到 partial（限流等），
 * 直接覆盖会把已有的 full 记录降级，之后依赖 Description / Comments / DownloadUrl 的功能全失效。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { getMoreCompleteVideoInfo, getVideoInfoCompleteness } from '../src/shared/videoInfo'
import type { VideoInfo } from '../src/shared/videoInfo'

function info(Type: VideoInfo['Type'], ID = 'v1'): VideoInfo {
    return { Type, ID } as VideoInfo
}

test('完整度分数按 full > partial > fail > cache > init 单调递增', () => {
    const order = ['init', 'cache', 'fail', 'partial', 'full'] as const
    for (let i = 1; i < order.length; i++) {
        const higher = order[i]!
        const lower = order[i - 1]!
        assert.ok(getVideoInfoCompleteness(info(higher)) > getVideoInfoCompleteness(info(lower)), `${higher} 应高于 ${lower}`)
    }
})

test('择优：full 与 partial 之间取 full', () => {
    const full = info('full')
    assert.equal(getMoreCompleteVideoInfo(info('partial'), full).Type, 'full')
    assert.equal(getMoreCompleteVideoInfo(full, info('partial')).Type, 'full')
})

test('择优：完整度相同时保留先传入的那个（不做无意义替换）', () => {
    const a = info('partial')
    const b = info('partial')
    assert.equal(getMoreCompleteVideoInfo(a, b), a)
})

test('择优：ID 不同直接抛错（那是调用方把两个视频搞混了）', () => {
    assert.throws(() => getMoreCompleteVideoInfo(info('full', 'v1'), info('full', 'v2')), /ID mismatch/)
})
