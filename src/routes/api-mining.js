const express = require('express');
const { randomUUID } = require('crypto');
const config = require('../config');
const { AppError, wrapAsync } = require('./error-handler');
const { requireAdmin } = require('../middleware/access-control');
const { requireNativeAddress } = require('./input-policy');

function createMiningRoutes(starCoin, p2p, broadcastToFrontend) {
    const router = express.Router(), jobs = new Map();
    let active = null, singleMining = false, streams = 0;
    router.use('/mine', requireAdmin);

    function address(body = {}) {
        const value = body.minerAddress || starCoin.miningAddress;
        if (typeof value !== 'string' || !value) throw new AppError(400, '必须提供 minerAddress 参数', 'MISSING_MINER');
        return requireNativeAddress(value);
    }
    function available() {
        if (active || singleMining) throw new AppError(409, '已有挖矿任务运行中', 'MINING_BUSY');
    }
    function publish(job, data) {
        job.latest = data;
        for (const res of job.subscribers) {
            if (!res.writableNeedDrain) res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    }
    function broadcast(block) {
        p2p.broadcastLatest(); p2p.broadcastPendingTxs(); p2p.updateNodeInfo();
        broadcastToFrontend('newBlock', { blockIndex: block.index, blockHash: block.hash,
            transactionCount: block.transactions.length, difficulty: starCoin.difficulty });
    }
    async function run(job, minerAddress, data) {
        try {
            let result;
            do {
                result = await starCoin.mineBlockAsync(minerAddress, data, progress => publish(job, progress), () => job.stopped);
                if (result?.canceled && !job.stopped) await new Promise(resolve => setTimeout(resolve, 200));
            } while (result?.canceled && !job.stopped);
            if (job.stopped || result?.canceled) publish(job, { stopped: true, message: '挖矿已停止' });
            else {
                if (!result?.hash) throw new Error('挖矿未返回有效区块');
                broadcast(result);
                publish(job, { found: true, nonce: result.nonce, hash: result.hash, difficulty: starCoin.difficulty,
                    block: { index: result.index, hash: result.hash, previousHash: result.previousHash,
                        nonce: result.nonce, timestamp: result.timestamp, transactionCount: result.transactions.length },
                    reward: starCoin.miningReward });
            }
        } catch { publish(job, { error: '挖矿失败，请检查节点日志' }); }
        finally {
            job.done = true;
            if (active === job) active = null;
            for (const res of job.subscribers) res.end();
            const timer = setTimeout(() => jobs.delete(job.id), 120000); timer.unref();
        }
    }

    router.post('/mine', wrapAsync(async (req, res) => {
        const minerAddress = address(req.body); available(); singleMining = true;
        const startTime = Date.now();
        try {
            const block = await starCoin.mineBlock(minerAddress, req.body.data);
            if (!block?.hash) throw new AppError(500, '挖矿未返回有效区块', 'MINE_FAILED');
            broadcast(block);
            res.json({ success: true, block, transactionCount: block.transactions.length,
                reward: starCoin.miningReward, miningTime: `${Date.now() - startTime}ms` });
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(400, '挖矿失败', 'MINE_FAILED');
        } finally { singleMining = false; }
    }));

    router.post('/mine/start', wrapAsync(async (req, res) => {
        const minerAddress = address(req.body); available();
        if (jobs.size >= 32) {
            const completed = [...jobs.values()].find(job => job.done);
            if (completed) jobs.delete(completed.id);
        }
        const job = { id: randomUUID(), stopped: false, done: false, latest: { started: true }, subscribers: new Set() };
        jobs.set(job.id, job); active = job;
        res.status(202).json({ success: true, jobId: job.id });
        job.promise = run(job, minerAddress, req.body.data);
    }));
    router.post('/mine/stop', wrapAsync(async (req, res) => {
        const job = jobs.get(req.body.jobId);
        if (!job) throw new AppError(404, '挖矿任务不存在', 'JOB_NOT_FOUND');
        job.stopped = true;
        await job.promise;
        res.json({ success: true, stopped: true });
    }));
    router.get('/mine/stream', wrapAsync(async (req, res) => {
        const job = jobs.get(req.query.jobId);
        if (!job) throw new AppError(404, '挖矿任务不存在，请先启动任务', 'JOB_NOT_FOUND');
        if (streams >= config.MINING_MAX_STREAMS) throw new AppError(429, '进度连接过多', 'TOO_MANY_STREAMS');
        streams++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(job.latest)}\n\n`);
        const heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': keepalive\n\n'); }, 15000);
        heartbeat.unref();
        const timeout = setTimeout(() => res.end(), 10 * 60 * 1000); timeout.unref();
        res.on('close', () => { streams--; job.subscribers.delete(res); clearInterval(heartbeat); clearTimeout(timeout); });
        if (job.done) res.end();
        else job.subscribers.add(res);
    }));
    return router;
}
module.exports = createMiningRoutes;
