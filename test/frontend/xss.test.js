const vm = require('vm');
const fs = require('fs');
const path = require('path');

// These renderers may never invoke an HTML parser with chain data.
class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; this.style = {}; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('unsafe HTML sink'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    addEventListener(event, handler) { this.events[event] = handler; }
    get childNodes() { return this.children; }
}
function setup() {
    const elements = new Map();
    const context = vm.createContext({ console, document: { createElement: tag => new Element(tag),
        createTextNode: value => Object.assign(new Element('#text'), { text: String(value) }),
        getElementById: id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
        addEventListener: () => {} },
        shortAddr: (value, length = 12) => String(value || '').slice(0, length), formatBalance: value => String(value),
        api: vi.fn(async () => ({ success: true, type: 'empty' })) });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/front/search.js'), 'utf8'), context);
    return { context, elements };
}
const evil = `<img src=x onerror="globalThis.pwned=1">');globalThis.pwned=1;//`;
const tx = { id: evil, from: evil, to: evil, amount: evil, currency: evil, note: evil, signature: evil, fee: evil };
describe('stored chain text rendering', () => {
    it('safely displays an actual confirmed historical transaction containing an HTML address', async () => {
        const express = require('express'), request = require('supertest');
        const { newFreshChain } = require('../helpers');
        const { generateWallet } = require('../../src/core');
        const chain = newFreshChain(), wallet = generateWallet(); chain.mineBlock(wallet.address);
        const transaction = chain.createTransaction(wallet.address, evil, 1, 0, evil, 'STC', 0);
        transaction.signTransaction(wallet.privateKey, wallet.publicKey); chain.addTransaction(transaction); chain.mineBlock(wallet.address);
        const app = express(); app.use(require('../../src/routes/api-search')(chain));
        const response = await request(app).get('/search').query({ q: transaction.id }).expect(200);
        const { context, elements } = setup(); context.renderSearchResults(response.body);
        expect(elements.get('searchResultsContent').textContent).toContain(evil);
        expect(context.pwned).toBeUndefined();
    });
    it.each(['block', 'transaction', 'address', 'address_list', 'note', 'mempool'])('uses text nodes for %s', type => {
        const { context, elements } = setup();
        const result = { block: { index: evil, hash: evil, previousHash: evil, nonce: evil, transactions: [tx] },
            transaction: tx, blockIndex: evil, blockHash: evil, confirmations: evil, address: evil,
            addresses: [{ address: evil, balance: 1, txCount: evil }], transactions: [tx], message: evil };
        expect(() => context.renderSearchResults({ success: true, type, result })).not.toThrow();
        expect(elements.get('searchResultsContent').textContent).toContain(evil);
        expect(context.pwned).toBeUndefined();
    });
    it('clicks retain the original address without evaluating it as JavaScript', () => {
        const { context, elements } = setup();
        const action = vi.fn(); const link = context.searchLink(evil, action, evil);
        link.events.click(); expect(action).toHaveBeenCalledWith(evil);
        expect(link.textContent).toBe(evil); expect(context.pwned).toBeUndefined();
        expect(elements.size).toBe(0);
    });
});
