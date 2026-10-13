const { Wallet, Interface } = require('ethers');
const { EvmBlockchain } = require('../../src/evm/blockchain');
const { generateWallet } = require('../../src/core');
const { withdrawalData } = require('../../src/evm/external-transaction');
const { restoreBlock } = require('../../src/consensus');
const artifact = require('../../public/contracts/Counter.json');
const native = { activationHeight: 1, legacyCheckpointHash: '', initialDifficulty: 1, difficultyMin: 0,
    coinbaseMaturity: 0, difficultyAdjustInterval: 1000000 };
async function setup(rpc = { activationHeight: 1 }) {
    const chain = new EvmBlockchain(45080, true, { consensus: native, rpc }); await chain.ready;
    const nativeWallet = generateWallet(), wallet = Wallet.createRandom();
    await chain.mineBlock(nativeWallet.address);
    await chain.submitEvm(nativeWallet.privateKey, { kind: 'deposit', amount: '10', evmAddress: wallet.address });
    await chain.mineBlock(nativeWallet.address);
    return { chain, nativeWallet, wallet };
}
async function raw(ctx, options = {}) {
    return ctx.wallet.signTransaction({ type: 2, chainId: ctx.chain.consensus.evm.chainId, nonce: await ctx.chain._poolEngine.nonce(ctx.wallet.address),
        gasLimit: 1000000n, maxFeePerGas: 30000000000n, maxPriorityFeePerGas: 1000000000n, ...options });
}
describe('MetaMask signed transactions', () => {
    it('executes external legacy, access-list and EIP-1559 transfers without native credentials', async () => {
        const ctx = await setup(), to = Wallet.createRandom().address;
        const nativeNonce = ctx.chain.getConfirmedNonce ? ctx.chain.getConfirmedNonce(ctx.nativeWallet.address) : ctx.chain.query.getConfirmedNonce(ctx.nativeWallet.address);
        for (const type of [0, 1, 2]) {
            const signed = await raw(ctx, { type, to, value: 123456789n, gasLimit: 30000n,
                ...(type < 2 ? { gasPrice: 30000000000n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined } : {}) });
            const tx = await ctx.chain.submitRaw(signed); await ctx.chain.mineBlock(ctx.nativeWallet.address);
            expect(ctx.chain.receipt(tx.id).status).toBe(1); expect(ctx.chain.getLatestBlock().version).toBe(4);
        }
        expect(await ctx.chain._evaluation.engine.balance(to)).toBe(370370367n);
        expect(ctx.chain.query.getConfirmedNonce(ctx.nativeWallet.address)).toBe(nativeNonce);
        expect(await ctx.chain._evaluation.engine.nonce(ctx.wallet.address)).toBe(3n);
        const replay = await ctx.chain.consensus.evaluateAsync(JSON.parse(JSON.stringify(ctx.chain.chain)));
        expect(replay.valid).toBe(true); expect(replay.evmStateRoot).toBe(ctx.chain._evaluation.evmStateRoot);
    });
    it('deploys and calls Counter; unsigned estimation never changes confirmed state', async () => {
        const ctx = await setup(), iface = new Interface(artifact.abi), root = ctx.chain._evaluation.evmStateRoot;
        const simulation = await ctx.chain._evaluation.engine.simulate({ from: ctx.wallet.address, data: artifact.bytecode }, ctx.chain.consensus.context(ctx.chain.chain));
        expect(simulation.status).toBe(1); expect(ctx.chain._evaluation.evmStateRoot).toBe(root);
        const deploy = await ctx.chain.submitRaw(await raw(ctx, { data: artifact.bytecode })); await ctx.chain.mineBlock(ctx.nativeWallet.address);
        const to = ctx.chain.receipt(deploy.id).contractAddress;
        const tx = await ctx.chain.submitRaw(await raw(ctx, { to, data: iface.encodeFunctionData('set', [123]) })); await ctx.chain.mineBlock(ctx.nativeWallet.address);
        expect(ctx.chain.receipt(tx.id).logs).toHaveLength(1); expect(BigInt(await ctx.chain._evaluation.engine.storage(to, '0'))).toBe(123n);
    });
    it('supports replacement and cancellation, rejects underpriced replacements and bad chain IDs', async () => {
        const ctx = await setup();
        const first = await ctx.chain.submitRaw(await raw(ctx, { nonce: 0, to: Wallet.createRandom().address, value: 1n }));
        await expect(ctx.chain.submitRaw(await raw(ctx, { nonce: 0, to: ctx.wallet.address }))).rejects.toThrow(/10%/);
        const replacement = await ctx.chain.submitRaw(await raw(ctx, { nonce: 0, to: ctx.wallet.address, maxFeePerGas: 34000000000n, maxPriorityFeePerGas: 1200000000n }));
        expect(ctx.chain.pendingTransactions.map(tx => tx.id)).toEqual([replacement.id]);
        await ctx.chain.mineBlock(ctx.nativeWallet.address); expect(ctx.chain.receipt(first.id).status).toBe('unknown');
        await expect(ctx.chain.submitRaw(await raw(ctx, { chainId: 155002 }))).rejects.toThrow();
        await expect(ctx.chain.submitRaw(replacement.rawTransaction)).rejects.toThrow();
    });
    it('binds EIP-712 withdrawal amount, recipient, network, nonce and expiry', async () => {
        const ctx = await setup(), deadline = String(Math.floor(Date.now() / 1000) + 1800);
        const data = withdrawalData(ctx.chain.consensus, ctx.wallet.address, ctx.nativeWallet.address, '100000001', '0', deadline);
        const signature = await ctx.wallet.signTypedData(data.domain, data.types, data.message);
        await expect(ctx.chain.submitWithdrawal({ ...data.message, amountUnits: '200000000' }, signature)).rejects.toThrow();
        const tx = await ctx.chain.submitWithdrawal(data.message, signature); await ctx.chain.mineBlock(ctx.nativeWallet.address);
        expect(ctx.chain.receipt(tx.id).status).toBe(1); expect(await ctx.chain._evaluation.engine.balance(ctx.wallet.address)).toBe(8999999990000000000n);
        expect(ctx.chain._evaluation.state.bridgeNonces.get(ctx.wallet.address.toLowerCase())).toBe(1n);
        await expect(ctx.chain.submitWithdrawal(data.message, signature)).rejects.toThrow();
        const expired = withdrawalData(ctx.chain.consensus, ctx.wallet.address, ctx.nativeWallet.address, '1', '1', '1');
        await expect(ctx.chain.submitWithdrawal(expired.message, await ctx.wallet.signTypedData(expired.domain, expired.types, expired.message))).rejects.toThrow(/过期/);
    });
    it('preserves v3 history at a fixed checkpoint and rejects forged baseFee headers', async () => {
        const old = await setup(null), hashes = old.chain.chain.map(block => block.hash);
        const upgraded = new EvmBlockchain(45081, true, { consensus: native, rpc: { activationHeight: hashes.length, checkpointHash: hashes.at(-1) } }); await upgraded.ready;
        expect(await upgraded.replaceChain(old.chain.chain)).toBe(true);
        await upgraded.mineBlock(old.nativeWallet.address);
        expect(upgraded.chain.slice(0, hashes.length).map(block => block.hash)).toEqual(hashes);
        const forged = restoreBlock((await upgraded.buildCandidate(old.nativeWallet.address)).block);
        forged.baseFeePerGas = '1'; forged.hash = forged.calculateHash(); forged.mineBlock(upgraded.difficulty);
        expect(await upgraded.addBlock(forged)).toBeNull();
    });
    it('reverts orphaned external state and revalidates raw transactions after a fork', async () => {
        const ctx = await setup();
        // A fork must start at exactly the same head, without unrelated setup blocks.
        const other = new EvmBlockchain(45082, true, { consensus: native, rpc: { activationHeight: 1 } }); await other.ready;
        await other.replaceChain(ctx.chain.chain);
        const tx = await ctx.chain.submitRaw(await raw(ctx, { to: Wallet.createRandom().address, value: 100n })); await ctx.chain.mineBlock(ctx.nativeWallet.address);
        await other.mineBlock(ctx.nativeWallet.address); await other.mineBlock(ctx.nativeWallet.address);
        expect(await ctx.chain.replaceChain(other.chain)).toBe(true); expect(ctx.chain.receipt(tx.id).wasReverted).toBe(true);
        expect(await ctx.chain._evaluation.engine.nonce(ctx.wallet.address)).toBe(0n);
        expect(ctx.chain.hasPendingTransaction(tx.id)).toBe(true);
    });
});
