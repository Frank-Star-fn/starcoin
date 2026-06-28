// ============================================================
// keystore.js 单元测试
//
// 测试范围：
// 1. 工具函数（stringToBytes / bytesToString / base64 互转）
// 2. 加密/解密（encryptPrivateKey → decryptPrivateKey 往返）
// 3. 密钥管理（getOrCreateMasterKey / deleteMasterKey）
// 4. 异常场景（密钥不匹配、数据损坏）
//
// 由于 keystore.js 依赖浏览器 API（crypto.subtle / indexedDB），
// 测试前需 mock 这些全局对象。加解密 mock 使用 Node.js crypto 模块
// 实现真实的 AES-256-GCM 加解密。
// ============================================================
'use strict';

const nodeCrypto = require('crypto');

// ============================================================
// ---------- mock: crypto.subtle + crypto.getRandomValues ----------
// 使用 Node.js 内置的 webcrypto.subtle（标准 Web Crypto API 实现），
// 确保 AES-256-GCM 往返测试正确
// ============================================================

const webcrypto = require('crypto').webcrypto;

/** mockSubtle：代理到 Node.js webcrypto.subtle */
const mockSubtle = {
    async generateKey(algorithm, extractable, keyUsages) {
        return webcrypto.subtle.generateKey(algorithm, extractable, keyUsages);
    },
    async encrypt(algorithm, key, data) {
        return webcrypto.subtle.encrypt(algorithm, key, data);
    },
    async decrypt(algorithm, key, data) {
        return webcrypto.subtle.decrypt(algorithm, key, data);
    },
};

// ============================================================
// ---------- mock: indexedDB 最小化实现（仅支持 keystore.js 所需操作） ----------
// 数据持久化在全局 idbData Map 中，跨多次 open() 调用
// ============================================================

/** 模拟 IndexedDB 数据存储：storeName → Map(key → value) */
const idbData = new Map();

class MockIDBRequest {
    constructor() {
        this.readyState = 'pending';
        this.result = null;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}

class MockIDBObjectStore {
    constructor(storeMap) {
        this._map = storeMap;
    }

    get(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = this._map.get(key) ?? null;
            req.readyState = 'done';
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }

    put(value) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this._map.set(value.key_id, value);
            req.readyState = 'done';
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }

    delete(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this._map.delete(key);
            req.readyState = 'done';
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
}

class MockIDBTransaction {
    constructor(storeMap, mode) {
        this._map = storeMap;
        this.mode = mode;
        this.oncomplete = null;
        this.onerror = null;
    }

    objectStore() {
        return new MockIDBObjectStore(this._map);
    }
}

class MockIDBDatabase {
    constructor(storeMap) {
        this._map = storeMap;
        this.objectStoreNames = {
            contains: (name) => this._map.has(name),
        };
    }

    transaction(_storeName, mode) {
        const map = this._map.get(_storeName);
        const tx = new MockIDBTransaction(map, mode);
        queueMicrotask(() => {
            if (tx.oncomplete) tx.oncomplete();
        });
        return tx;
    }

    close() { /* no-op */ }

    createObjectStore(name, _options) {
        if (!this._map.has(name)) {
            this._map.set(name, new Map());
        }
    }
}

/** 确保 master_keys store 在首次访问前已创建 */
function ensureMasterKeysStore() {
    if (!idbData.has('master_keys')) {
        idbData.set('master_keys', new Map());
    }
}

const mockIndexedDB = {
    open(_dbName, _version) {
        const req = new MockIDBRequest();

        queueMicrotask(() => {
            // 首次打开时触发 onupgradeneeded（创建 store）
            if (!idbData.has('master_keys')) {
                if (req.onupgradeneeded) {
                    const db = new MockIDBDatabase(idbData);
                    req.onupgradeneeded({ target: { result: db } });
                }
            }
            // 确保 store 存在
            ensureMasterKeysStore();

            const db = new MockIDBDatabase(idbData);
            req.result = db;
            req.readyState = 'done';
            if (req.onsuccess) req.onsuccess({ target: { result: db } });
        });
        return req;
    },
};

// ============================================================
// ---------- 挂载 mock 到 globalThis ----------
// 必须在 require(keystore.js) 之前执行
// ============================================================

beforeAll(() => {
    vi.stubGlobal('crypto', {
        getRandomValues: (array) => webcrypto.getRandomValues(array),
        subtle: mockSubtle,
    });
    vi.stubGlobal('indexedDB', mockIndexedDB);
});

afterEach(() => {
    // 清空 IDB 数据，避免测试间污染
    idbData.clear();
});

// ============================================================
// ---------- 加载被测模块 ----------
// ============================================================

let keystore;

beforeAll(async () => {
    // 清除可能的上次加载的缓存
    delete require.cache[require.resolve('../../src/front/keystore')];
    keystore = require('../../src/front/keystore');

    // 确保主密钥就绪（不使用模块的自动调用，手动触发一次）
    // 后续测试用例各自独立获取密钥
});

// ============================================================
// 第1组: 工具函数测试
// ============================================================
describe('工具函数', () => {
    it('stringToBytes / bytesToString 往返转换', () => {
        const original = 'Hello, 世界！';
        const bytes = keystore.stringToBytes(original);
        const result = keystore.bytesToString(bytes);
        expect(result).toBe(original);
    });

    it('arrayBufferToBase64 / base64ToBytes 往返转换', () => {
        const buffer = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
        const b64 = keystore.arrayBufferToBase64(buffer.buffer);
        const decoded = keystore.base64ToBytes(b64);
        expect(new Uint8Array(decoded)).toEqual(buffer);
    });

    it('base64 编码不包含换行符', () => {
        const buffer = new Uint8Array(100).buffer;
        const b64 = keystore.arrayBufferToBase64(buffer);
        expect(b64).not.toMatch(/[\r\n]/);
    });

    it('空字符串的编码/解码', () => {
        const original = '';
        const bytes = keystore.stringToBytes(original);
        expect(bytes.length).toBe(0);
        const result = keystore.bytesToString(bytes);
        expect(result).toBe(original);
    });

    it('base64 处理二进制数据（含 0x00 字节）', () => {
        const buffer = new Uint8Array([0x00, 0x01, 0xFF, 0x80, 0x7F]).buffer;
        const b64 = keystore.arrayBufferToBase64(buffer);
        const decoded = keystore.base64ToBytes(b64);
        const original = new Uint8Array(buffer);
        expect(new Uint8Array(decoded)).toEqual(original);
    });
});

// ============================================================
// 第2组: 密钥管理测试
// ============================================================
describe('密钥管理', () => {
    it('getOrCreateMasterKey() 首次调用生成新密钥', async () => {
        const key = await keystore.getOrCreateMasterKey();
        expect(key).toBeTruthy();
        expect(key.type).toBe('secret');
        expect(key.algorithm.name).toBe('AES-GCM');
        expect(key.extractable).toBe(false);
        expect(key.usages).toContain('encrypt');
        expect(key.usages).toContain('decrypt');
    });

    it('getOrCreateMasterKey() 第二次调用返回同一密钥', async () => {
        const key1 = await keystore.getOrCreateMasterKey();
        // 从 IDB 读取应返回同一对象引用
        const key2 = await keystore.getOrCreateMasterKey();
        expect(key2).toBe(key1);
    });

    it('deleteMasterKey() 删除后 getOrCreateMasterKey 生成新密钥', async () => {
        const key1 = await keystore.getOrCreateMasterKey();
        await keystore.deleteMasterKey();
        const key2 = await keystore.getOrCreateMasterKey();
        // 两个 CryptoKey 对象引用不同，即为不同的密钥
        expect(key1).not.toBe(key2);
    });
});

// ============================================================
// 第3组: 加密/解密往返测试
// ============================================================
describe('私钥加解密', () => {
    const SAMPLE_PEM = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIIm3V2B6vW3qF3Vx3Y9qF5sZ0kG6n8KXz6f0y0L1oAcDoAcGBSuBBAAi
oS6A5IAAAA=
-----END EC PRIVATE KEY-----`;

    let masterKey;

    beforeAll(async () => {
        masterKey = await keystore.getOrCreateMasterKey();
    });

    it('加密私钥返回正确的数据结构', async () => {
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        expect(enc).toBeTruthy();
        expect(enc.ciphertext).toBeTruthy();
        expect(typeof enc.ciphertext).toBe('string');
        expect(enc.iv).toBeTruthy();
        expect(typeof enc.iv).toBe('string');
        expect(enc.algo).toBe('AES-GCM');
        expect(enc.version).toBe(1);
    });

    it('两次加密同一私钥产生不同的密文（IV 随机性）', async () => {
        const enc1 = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        const enc2 = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
        expect(enc1.iv).not.toBe(enc2.iv);
    });

    it('encrypt → decrypt 往返后还原原始 PEM', async () => {
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        const decrypted = await keystore.decryptPrivateKey(enc, masterKey);
        expect(decrypted).toBe(SAMPLE_PEM);
    });

    it('加密时不传 masterKey 则自动获取', async () => {
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM);
        expect(enc.ciphertext).toBeTruthy();
        const decrypted = await keystore.decryptPrivateKey(enc);
        expect(decrypted).toBe(SAMPLE_PEM);
    });

    it('使用不匹配的密钥解密应抛出异常', async () => {
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        // 删除当前密钥，下次 getOrCreateMasterKey 会生成新密钥
        await keystore.deleteMasterKey();
        const wrongKey = await keystore.getOrCreateMasterKey();

        await expect(
            keystore.decryptPrivateKey(enc, wrongKey)
        ).rejects.toThrow();
    });

    it('解密损坏的数据应抛出异常', async () => {
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM, masterKey);
        // 篡改密文
        const corrupted = { ...enc, ciphertext: enc.ciphertext + 'AA==' };
        await expect(
            keystore.decryptPrivateKey(corrupted, masterKey)
        ).rejects.toThrow();
    });

    it('解密空的 ciphertext 应抛出异常', async () => {
        const fakeEnc = {
            ciphertext: '',
            iv: keystore.arrayBufferToBase64(nodeCrypto.randomBytes(12)),
            algo: 'AES-GCM',
            version: 1,
        };
        await expect(
            keystore.decryptPrivateKey(fakeEnc, masterKey)
        ).rejects.toThrow();
    });

    it('加密/解密未传入 masterKey 时自动创建（完整使用流程）', async () => {
        // 删除已有密钥，模拟全新环境
        await keystore.deleteMasterKey();
        const enc = await keystore.encryptPrivateKey(SAMPLE_PEM);
        const decrypted = await keystore.decryptPrivateKey(enc);
        expect(decrypted).toBe(SAMPLE_PEM);
    });
});

// ============================================================
// 第4组: 大数据量和边界情况
// ============================================================
describe('边界情况', () => {
    let masterKey;

    beforeAll(async () => {
        await keystore.deleteMasterKey();
        masterKey = await keystore.getOrCreateMasterKey();
    });

    it('加密/解密空字符串 PEM', async () => {
        const pem = '';
        const enc = await keystore.encryptPrivateKey(pem, masterKey);
        const decrypted = await keystore.decryptPrivateKey(enc, masterKey);
        expect(decrypted).toBe(pem);
    });

    it('加密/解密较大 PEM 数据（10KB）', async () => {
        const bigPem = '-----BEGIN KEY-----\n' + 'A'.repeat(10000) + '\n-----END KEY-----';
        const enc = await keystore.encryptPrivateKey(bigPem, masterKey);
        const decrypted = await keystore.decryptPrivateKey(enc, masterKey);
        expect(decrypted).toBe(bigPem);
    });

    it('加密/解密含有特殊字符的 PEM', async () => {
        const specialPem = `-----BEGIN KEY-----
Line1: ABCDEFGHIJKLMNOPQRSTUVWXYZ
Line2: abcdefghijklmnopqrstuvwxyz
Line3: 0123456789
Line4: !@#$%^&*()_+-=[]{}|;':\",./<>?~
Line5: 你好世界
-----END KEY-----`;
        const enc = await keystore.encryptPrivateKey(specialPem, masterKey);
        const decrypted = await keystore.decryptPrivateKey(enc, masterKey);
        expect(decrypted).toBe(specialPem);
    });
});

// ============================================================
// 第5组: IndexedDB 异常场景
// ============================================================
describe('IndexedDB 异常处理', () => {
    it('indexedDB 不可用时 loadMasterKeyFromDB 应抛出友好错误', async () => {
        // 临时替换 indexedDB 为失败 mock
        const originalIndexedDB = globalThis.indexedDB;
        vi.stubGlobal('indexedDB', {
            open(_name, _ver) {
                const req = new MockIDBRequest();
                queueMicrotask(() => {
                    req.readyState = 'done';
                    req.error = new Error('Mock IndexedDB 不可用');
                    if (req.onerror) req.onerror({ target: req });
                });
                return req;
            },
        });

        await expect(keystore.loadMasterKeyFromDB()).rejects.toThrow();

        // 恢复原始 mock
        vi.stubGlobal('indexedDB', originalIndexedDB);
    });
});