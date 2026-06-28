// ============================================================
// test/middleware/rate-limit.test.js — API 限流中间件测试
// ============================================================
const express = require('express');
const request = require('supertest');
const createRateLimiter = require('../../src/middleware/rate-limit');

describe('rate-limit 中间件', () => {

    // ------------------------------------------------------------
    // 基本功能
    // ------------------------------------------------------------
    describe('基本功能', () => {
        it('请求未超限 → 正常放行并调用 next()', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 10 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            const res = await request(app).get('/test');
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
        });

        it('超限 → 返回 429 TOO_MANY_REQUESTS', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 2 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            // 前 2 次通过
            await request(app).get('/test');
            await request(app).get('/test');
            // 第 3 次应被拒绝
            const res = await request(app).get('/test');
            expect(res.status).toBe(429);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('TOO_MANY_REQUESTS');
            expect(res.body.error).toContain('频繁');
        });

        it('返回响应头 X-RateLimit-Limit / Remaining / Reset', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 5 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            const res = await request(app).get('/test');
            expect(res.headers['x-ratelimit-limit']).toBe('5');
            expect(res.headers['x-ratelimit-remaining']).toBe('4');
            expect(res.headers['x-ratelimit-reset']).toBeDefined();
        });

        it('超限响应包含 Retry-After 和 details.resetAfterMs', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 1 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            await request(app).get('/test');
            const res = await request(app).get('/test');
            expect(res.status).toBe(429);
            expect(res.headers['retry-after']).toBeDefined();
            expect(res.body.details.limit).toBe(1);
            expect(res.body.details.remaining).toBe(0);
            expect(typeof res.body.details.resetAfterMs).toBe('number');
            expect(res.body.details.resetAfterMs).toBeGreaterThanOrEqual(0);
        });
    });

    // ------------------------------------------------------------
    // 基于 IP 隔离：不同 IP 各自独立计数
    // ------------------------------------------------------------
    describe('IP 隔离', () => {
        it('不同 IP 拥有独立的计数器', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 1 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            // IP A 超限
            await request(app).get('/test').set('X-Forwarded-For', '10.0.0.1');
            const rA = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.1');
            expect(rA.status).toBe(429);

            // IP B 仍可正常访问
            const rB = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.2');
            expect(rB.status).toBe(200);
        });

        it('X-Forwarded-For 中的第一个 IP 被用作 key', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 1 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            await request(app).get('/test').set('X-Forwarded-For', '10.0.0.3, 10.0.0.99');
            const res = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.3, 10.0.0.99');
            expect(res.status).toBe(429);
        });

        it('X-Real-IP 作为 fallback', async () => {
            const app = express();
            app.use(createRateLimiter({ windowMs: 60000, max: 1 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            await request(app).get('/test').set('X-Real-IP', '10.0.0.4');
            const res = await request(app).get('/test').set('X-Real-IP', '10.0.0.4');
            expect(res.status).toBe(429);
        });
    });

    // ------------------------------------------------------------
    // 滑动窗口：窗口时间过去后应放行
    // ------------------------------------------------------------
    describe('滑动窗口', () => {
        it('窗口时间过去后，计数器重置并再次放行', async () => {
            const app = express();
            const windowMs = 200;  // 非常短的窗口，便于测试
            app.use(createRateLimiter({ windowMs, max: 2 }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            // 填满窗口
            await request(app).get('/test');
            await request(app).get('/test');
            const r = await request(app).get('/test');
            expect(r.status).toBe(429);

            // 等待窗口过期
            await new Promise(resolve => setTimeout(resolve, windowMs + 50));

            // 应再次通过
            const res = await request(app).get('/test');
            expect(res.status).toBe(200);
        });
    });

    // ------------------------------------------------------------
    // 多实例独立：不同 createRateLimiter 调用拥有独立计数器
    // ------------------------------------------------------------
    describe('多实例独立', () => {
        it('两个限流实例拥有独立的计数器', async () => {
            const app = express();
            const limiterA = createRateLimiter({ windowMs: 60000, max: 1 });  // 严格
            const limiterB = createRateLimiter({ windowMs: 60000, max: 10 }); // 宽松
            app.get('/a', limiterA, (req, res) => res.json({ path: 'a' }));
            app.get('/b', limiterB, (req, res) => res.json({ path: 'b' }));

            // 访问 /a 两次 → 第二次拒绝
            await request(app).get('/a');
            const a = await request(app).get('/a');
            expect(a.status).toBe(429);

            // /b 仍可正常访问（独立计数器）
            const b = await request(app).get('/b');
            expect(b.status).toBe(200);
        });
    });

    // ------------------------------------------------------------
    // 可配置 message
    // ------------------------------------------------------------
    describe('可配置 message', () => {
        it('自定义 message 会出现在错误响应中', async () => {
            const app = express();
            app.use(createRateLimiter({
                windowMs: 60000,
                max: 1,
                message: '写操作过于频繁'
            }));
            app.get('/test', (req, res) => res.json({ ok: true }));

            await request(app).get('/test');
            const res = await request(app).get('/test');
            expect(res.status).toBe(429);
            expect(res.body.error).toContain('写操作过于频繁');
        });
    });
});

// ============================================================
// 集成到 routes/index.js 的路由分级限流测试
// ============================================================
describe('routes/index.js — 分级限流集成', () => {
    it('连续调用写操作接口（POST /wallet/new）超出限制 → 429', async () => {
        // 注意：需要重写 config 值来设置一个低的 max，方便测试
        const origMax = process.env.RATE_LIMIT_WRITE_MAX;
        process.env.RATE_LIMIT_WRITE_MAX = '2';
        process.env.RATE_LIMIT_GLOBAL_MAX = '100';  // 全局足够大，不干扰

        // 每次 require 都会创建新实例，重新加载模块
        delete require.cache[require.resolve('../../src/config')];
        delete require.cache[require.resolve('../../src/routes')];

        const config = require('../../src/config');
        const createRoutes = require('../../src/routes');

        const app = express();
        app.use(express.json());
        app.use(createRoutes(
            { isChainValid: () => true, getLatestBlock: () => ({ hash: 'x' }), chain: [] },
            { getNodeUrls: () => [], getConnectedCount: () => 0 },
            () => { },
            3000
        ));

        // 前 2 次写操作应正常返回（钱包生成成功或失败都不是 429）
        const r1 = await request(app).post('/wallet/new');
        const r2 = await request(app).post('/wallet/new');
        expect(r1.status).not.toBe(429);
        expect(r2.status).not.toBe(429);

        // 第 3 次写操作 → 429
        const r3 = await request(app).post('/wallet/new');
        expect(r3.status).toBe(429);
        expect(r3.body.code).toBe('TOO_MANY_REQUESTS');

        // 恢复
        if (origMax !== undefined) {
            process.env.RATE_LIMIT_WRITE_MAX = origMax;
        } else {
            delete process.env.RATE_LIMIT_WRITE_MAX;
        }
        delete process.env.RATE_LIMIT_GLOBAL_MAX;
    });

    it('搜索路由使用独立限制', async () => {
        const origSearch = process.env.RATE_LIMIT_SEARCH_MAX;
        const origGlobal = process.env.RATE_LIMIT_GLOBAL_MAX;
        process.env.RATE_LIMIT_SEARCH_MAX = '1';
        process.env.RATE_LIMIT_GLOBAL_MAX = '100';

        delete require.cache[require.resolve('../../src/config')];
        delete require.cache[require.resolve('../../src/routes')];

        const createRoutes = require('../../src/routes');

        const app = express();
        app.use(express.json());
        app.use(createRoutes(
            { search: () => ({ type: 'empty', result: null }), pendingTransactions: [], chain: [] },
            { getNodeUrls: () => [], getConnectedCount: () => 0 },
            () => { },
            3000
        ));

        // 第 1 次搜索 → 正常
        const r1 = await request(app).get('/search?q=test');
        expect(r1.status).not.toBe(429);

        // 第 2 次搜索 → 429
        const r2 = await request(app).get('/search?q=test');
        expect(r2.status).toBe(429);

        // 恢复
        if (origSearch !== undefined) process.env.RATE_LIMIT_SEARCH_MAX = origSearch;
        else delete process.env.RATE_LIMIT_SEARCH_MAX;
        if (origGlobal !== undefined) process.env.RATE_LIMIT_GLOBAL_MAX = origGlobal;
        else delete process.env.RATE_LIMIT_GLOBAL_MAX;
    });
});