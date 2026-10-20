/**
 * 主机名分层（钓鱼仿冒判定）。
 *
 * 这些用例守两件事：
 * 1. **官方域名不能被误判**：误判会让正常用户在 iwara.tv 上看到钓鱼警告；
 * 2. **常见仿冒构造必须被抓到**：`iwara.tv.evil.com`（后缀伪装）、
 *    `iwara-video.xyz`（连字符）、`www.iwara.co`（换 TLD）——这三种是最常见的做法。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { OFFICIAL_DOMAINS, PHISHING_KEYWORDS, classifyHost } from '../src/shared/site'

test('官方域名及其子域判为 official', () => {
    for (const domain of OFFICIAL_DOMAINS) {
        assert.equal(classifyHost(domain), 'official', domain)
        assert.equal(classifyHost(`www.${domain}`), 'official', `www.${domain}`)
        assert.equal(classifyHost(`a.b.${domain}`), 'official', `a.b.${domain}`)
    }
})

test('大小写与结尾点号不影响判定（用户与浏览器都会给出这些形态）', () => {
    assert.equal(classifyHost('IWARA.TV'), 'official')
    assert.equal(classifyHost('iwara.tv.'), 'official')
    assert.equal(classifyHost('  iwara.tv  '), 'official')
})

test('后缀伪装：iwara.tv.evil.com 必须判为 suspicious', () => {
    // 只看 endsWith('iwara.tv') 会把这一串判成官方站点——这正是要防的构造
    assert.equal(classifyHost('iwara.tv.evil.com'), 'suspicious')
    assert.equal(classifyHost('www.iwara.tv.phish.example'), 'suspicious')
})

test('常见仿冒构造都落入 suspicious', () => {
    for (const host of ['iwara-video.xyz', 'iwara-download.net', 'www.iwara.co', 'lwara-mirror.example'.replace('lwara', 'iwara'), 'notiwara.example']) {
        assert.equal(classifyHost(host), 'suspicious', host)
    }
})

test('不带品牌词的普通站点判为 other（不打扰）', () => {
    for (const host of ['example.com', 'github.com', 'iwra.example', '']) {
        assert.equal(classifyHost(host), 'other', JSON.stringify(host))
    }
})

test('关键词清单是非空的，否则防护会静默失效', () => {
    assert.ok(PHISHING_KEYWORDS.length > 0)
    assert.ok(OFFICIAL_DOMAINS.length > 0)
})
