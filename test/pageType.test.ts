/**
 * 页面路由识别单元测试
 *
 * 价值：页内菜单/复选框的**显示与隐藏**完全由这里决定。判错会让详情页出现
 * 「本页全选」、或在列表页丢掉「下载当前视频」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoListPath, pageTypeOf, videoIdFromPath } from '../src/shared/pageType'

test('详情页 /video/:id 与短链 /v/:id', () => {
    assert.equal(videoIdFromPath('/video/AeGUIRO2D5vQ6F'), 'AeGUIRO2D5vQ6F')
    assert.equal(videoIdFromPath('/v/AeGUIRO2D5vQ6F'), 'AeGUIRO2D5vQ6F')
    assert.equal(videoIdFromPath('/video/AeGUIRO2D5vQ6F/estet-lucia'), 'AeGUIRO2D5vQ6F')
    assert.equal(videoIdFromPath('/videos'), null)
    assert.equal(videoIdFromPath('/'), null)
})

test('页类型判定', () => {
    assert.equal(pageTypeOf('/video/abc'), 'video')
    assert.equal(pageTypeOf('/videos'), 'videoList')
    assert.equal(pageTypeOf('/'), 'videoList')
    // 参数说明：pageTypeOf 接收的是 pathname（不含 query），调用方传 location.pathname
    assert.equal(pageTypeOf('/search'), 'videoList')
    assert.equal(pageTypeOf('/profile/dawn'), 'videoList')
    assert.equal(pageTypeOf('/playlist/xyz'), 'videoList')
    assert.equal(pageTypeOf('/favorites'), 'videoList')
    assert.equal(pageTypeOf('/settings'), 'other')
    assert.equal(pageTypeOf('/user/dawn'), 'other')
})

test('列表页判定与 detail 不重叠', () => {
    assert.equal(isVideoListPath('/videos'), true)
    assert.equal(isVideoListPath('/video/abc'), false)
})
