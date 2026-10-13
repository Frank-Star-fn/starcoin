const fs = require('fs'), path = require('path'), vm = require('vm');
function setup(api, fetch = vi.fn()) {
    const context = vm.createContext({ api, fetch, AbortController, TextDecoder, console,
        adminHeaders: () => ({ Authorization: 'Bearer test-admin' }) });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front/mining.js'), 'utf8'), context);
    return context;
}
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
        const bytes = new TextEncoder().encode('data: {"found":true,"message":"挖矿成功"}\n\n');
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
});
