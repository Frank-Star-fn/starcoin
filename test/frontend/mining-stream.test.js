const fs = require('fs'), path = require('path'), vm = require('vm');
function setup(api, fetch = vi.fn(), extra = {}) {
    const context = vm.createContext({ api, fetch, AbortController, TextDecoder, console,
        adminHeaders: () => ({ Authorization: 'Bearer test-admin' }), ...extra });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front/mining.js'), 'utf8'), context);
    return context;
}
function streamResponse(events) {
    const parts = [new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))];
    return { ok: true, body: { getReader: () => ({ read: async () => parts.length ? { value: parts.shift(), done: false } : { done: true } }) } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
describe('authenticated browser mining stream', () => {
    it('awaits a delayed start before stopping, so a new job cannot race the old one', async () => {
        let ready; const start = new Promise(resolve => { ready = resolve; });
        const api = vi.fn(url => url.endsWith('/start') ? start : Promise.resolve({ success: true }));
        const context = setup(api), source = context.openMiningStream('a'.repeat(32));
        let finished = false; const stopping = source.close().then(() => { finished = true; });
        await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false);
        ready({ jobId: 'test-job' }); await stopping;
        expect(api).toHaveBeenCalledWith('/api/mine/stop', 'POST', { jobId: 'test-job' });
        expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(1);
        expect(context.fetch).not.toHaveBeenCalled();
    });
    it('decodes fragmented UTF-8 SSE and sends authorization only in the header', async () => {
        const bytes = new TextEncoder().encode('data: {"found":true,"message":"挖矿成功","block":{"index":1}}\n\n');
        const parts = [bytes.slice(0, 35), bytes.slice(35, 37), bytes.slice(37)];
        const fetch = vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => parts.length ? { value: parts.shift(), done: false } : { done: true } }) } }));
        const api = vi.fn(async () => ({ jobId: 'test-job' })), context = setup(api, fetch);
        const source = context.openMiningStream('a'.repeat(32));
        const received = new Promise(resolve => { source.onmessage = event => { resolve(JSON.parse(event.data)); source.close(); }; });
        expect((await received).message).toBe('挖矿成功');
        expect(fetch.mock.calls[0][0]).toBe('/api/mine/stream?jobId=test-job');
        expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-admin');
        expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(0);
    });
    it('stops processing the current batch immediately after the source is closed', async () => {
        const api = vi.fn(async () => ({ jobId: 'test-job' }));
        const context = setup(api, vi.fn(async () => streamResponse([{ nonce: 1 }, { nonce: 2 }])));
        const source = context.openMiningStream('a'.repeat(32)), received = [];
        source.onmessage = event => { received.push(JSON.parse(event.data)); source.close(); };
        await flush();
        expect(received).toEqual([{ nonce: 1 }]);
        expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(1);
    });
    it('delivers a committed completion only once even when the callback does not close the stream', async () => {
        const completed = { found: true, block: { index: 1 } };
        const api = vi.fn(async () => ({ jobId: 'test-job' }));
        const context = setup(api, vi.fn(async () => streamResponse([completed, completed])));
        const source = context.openMiningStream('a'.repeat(32)), received = [];
        source.onmessage = event => received.push(JSON.parse(event.data));
        await flush();
        expect(received).toEqual([completed]);
        expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(0);
    });
    it('preserves the HTTP status for failed progress subscriptions', async () => {
        const api = vi.fn(async () => ({ jobId: 'test-job' }));
        const context = setup(api, vi.fn(async () => ({ ok: false, status: 403 })));
        const source = context.openMiningStream('a'.repeat(32));
        source.onerror = vi.fn(); await flush();
        expect(source.onerror.mock.calls[0][0].statusCode).toBe(403);
        await source.close();
    });
});

describe('automatic mining round handoff', () => {
    let elements;
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        elements = new Map();
    });
    afterEach(() => vi.useRealTimers());
    function automatic(api, fetch) {
        const context = setup(api, fetch, {
            document: { getElementById(id) {
                if (!elements.has(id)) elements.set(id, { style: {}, className: '', textContent: '', offsetWidth: 0 });
                return elements.get(id);
            } },
            setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
            debouncedRefreshAll: () => {}, showMessage: () => {}
        });
        vm.runInContext("autoMineState.active = true; autoMineState.minerAddress = 'a'.repeat(32); autoMineState.startTime = Date.now();", context);
        return context;
    }
    it('continues for three rounds with one counter increment and one next-round timer per block', async () => {
        let height = 0;
        const api = vi.fn(async () => ({ jobId: 'job-' + (height + 1) }));
        const fetch = vi.fn(async () => {
            const solved = { found: true, nonce: 1, hash: '0'.repeat(64), difficulty: 1 };
            const completed = { ...solved, block: { index: ++height } };
            return streamResponse([solved, completed, completed]);
        });
        const context = automatic(api, fetch);
        await Promise.all([context.startNextAutoMine(), context.startNextAutoMine()]);
        for (let round = 1; round <= 3; round++) {
            await flush();
            expect(vm.runInContext('autoMineState.blocksMined', context)).toBe(round);
            expect(vm.runInContext('autoMineState.active', context)).toBe(true);
            expect(api.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(round);
            expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(1);
            if (round < 3) await vi.advanceTimersByTimeAsync(500);
        }
        await context.toggleAutoMine();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('waits for cancellation before retrying a disconnected job', async () => {
        let finishStop;
        const stopping = new Promise(resolve => { finishStop = resolve; });
        const api = vi.fn(url => url.endsWith('/stop') ? stopping : Promise.resolve({ jobId: 'test-job' }));
        const fetch = vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValue({
            ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) }
        });
        const context = automatic(api, fetch);
        await context.startNextAutoMine(); await flush();
        expect(api.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        await context.startNextAutoMine();
        expect(api.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
        finishStop({ success: true }); await flush();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(500); await flush();
        expect(api.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(2);
        await context.toggleAutoMine();
    });
    it('ignores duplicate completion and late error callbacks from a finished round', async () => {
        const api = vi.fn(async () => ({ jobId: 'test-job' }));
        const context = automatic(api, vi.fn(async () => ({
            ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) }
        })));
        await context.startNextAutoMine();
        const source = vm.runInContext('autoMineState.eventSource', context);
        const event = { data: JSON.stringify({ found: true, block: { index: 1 } }) };
        source.onmessage(event); source.onmessage(event);
        await source.onerror(Object.assign(new Error('已有挖矿任务运行中'), { statusCode: 409 }));
        expect(vm.runInContext('autoMineState.blocksMined', context)).toBe(1);
        expect(vm.runInContext('autoMineState.active', context)).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await context.toggleAutoMine();
    });
    it('shows a busy-task error directly instead of retrying five duplicate starts', async () => {
        const api = vi.fn(async () => { throw Object.assign(new Error('已有挖矿任务运行中'), { statusCode: 409 }); });
        const context = automatic(api, vi.fn());
        await context.startNextAutoMine(); await flush();
        expect(vm.runInContext('autoMineState.active', context)).toBe(false);
        expect(elements.get('autoMineStatus').textContent).toContain('已有挖矿任务运行中');
        expect(api).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('keeps the actual failure reason when the retry limit is reached', async () => {
        const api = vi.fn(async () => { throw new Error('HTTP 500'); });
        const context = automatic(api, vi.fn());
        vm.runInContext('autoMineState.consecutiveFailures = 4;', context);
        await context.startNextAutoMine(); await flush();
        expect(vm.runInContext('autoMineState.active', context)).toBe(false);
        expect(elements.get('autoMineStatus').textContent).toContain('连续失败，已停止（HTTP 500）');
    });
});
