/* ============================================================
   keystore.js — 密钥管理 + 加解密（纯前端 Web Crypto + IndexedDB）
   
   核心设计：
   - AES-256-GCM 加密私钥
   - 加密密钥由浏览器自动生成（extractable: false），存入 IndexedDB
   - 对用户透明，无需密码
   ============================================================ */

const KEYSTORE_DB_NAME = 'starcoin_keystore';
const KEYSTORE_DB_VERSION = 1;
const KEYSTORE_STORE_NAME = 'master_keys';
const KEYSTORE_KEY_ID = 'default';

// ============================================================
// IndexedDB 封装
// ============================================================

/**
 * 打开 IndexedDB 数据库
 * @returns {Promise<IDBDatabase>}
 */
function openKeystoreDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(KEYSTORE_DB_NAME, KEYSTORE_DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) {
                db.createObjectStore(KEYSTORE_STORE_NAME, { keyPath: 'key_id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('无法打开 IndexedDB（Keystore）'));
    });
}

/**
 * 从 IndexedDB 读取加密密钥
 * @returns {Promise<CryptoKey|null>}
 */
async function loadMasterKeyFromDB() {
    const db = await openKeystoreDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(KEYSTORE_STORE_NAME, 'readonly');
        const store = tx.objectStore(KEYSTORE_STORE_NAME);
        const req = store.get(KEYSTORE_KEY_ID);
        req.onsuccess = () => {
            resolve(req.result ? req.result.cryptoKey : null);
        };
        req.onerror = () => reject(new Error('读取加密密钥失败'));
        tx.oncomplete = () => db.close();
    });
}

/**
 * 将加密密钥存入 IndexedDB
 * @param {CryptoKey} key
 * @returns {Promise<void>}
 */
async function saveMasterKeyToDB(key) {
    const db = await openKeystoreDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(KEYSTORE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KEYSTORE_STORE_NAME);
        store.put({
            key_id: KEYSTORE_KEY_ID,
            cryptoKey: key,
            createdAt: Date.now(),
            version: 1
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(new Error('保存加密密钥失败'));
    });
}

// ============================================================
// 主密钥管理
// ============================================================

/**
 * 获取或创建主加密密钥
 * - 首次调用：生成 AES-256-GCM 密钥（extractable: false），存入 IndexedDB
 * - 后续调用：从 IndexedDB 读取
 * @returns {Promise<CryptoKey>}
 */
async function getOrCreateMasterKey() {
    let key = await loadMasterKeyFromDB();
    if (key) return key;

    key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // extractable: false → 不可导出
        ['encrypt', 'decrypt']
    );

    await saveMasterKeyToDB(key);
    return key;
}

/**
 * 删除主密钥（重置用）
 * @returns {Promise<void>}
 */
async function deleteMasterKey() {
    const db = await openKeystoreDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(KEYSTORE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KEYSTORE_STORE_NAME);
        store.delete(KEYSTORE_KEY_ID);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(new Error('删除加密密钥失败'));
    });
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 将字符串编码为 Uint8Array
 * @param {string} str
 * @returns {Uint8Array}
 */
function stringToBytes(str) {
    return new TextEncoder().encode(str);
}

/**
 * 将 Uint8Array 解码为字符串
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToString(bytes) {
    return new TextDecoder().decode(bytes);
}

/**
 * 将 ArrayBuffer 转为 base64 字符串
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 将 base64 字符串转为 Uint8Array
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ============================================================
// 核心加解密 API
// ============================================================

/**
 * 加密 PEM 私钥
 * @param {string} pemText - 明文 PEM 字符串
 * @param {CryptoKey} [masterKey] - 加密密钥，不传则自动获取
 * @returns {Promise<{ciphertext: string, iv: string, algo: string, version: number}>}
 */
async function encryptPrivateKey(pemText, masterKey) {
    if (!masterKey) masterKey = await getOrCreateMasterKey();

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const dataBytes = stringToBytes(pemText);

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        masterKey,
        dataBytes
    );
    // encrypted 是 ArrayBuffer，包含：密文 + GCM 认证标签（末 16 字节）
    return {
        ciphertext: arrayBufferToBase64(encrypted),
        iv: arrayBufferToBase64(iv),
        algo: 'AES-GCM',
        version: 1
    };
}

/**
 * 解密 PEM 私钥
 * @param {{ciphertext: string, iv: string, algo?: string, version?: number}} enc - 加密数据
 * @param {CryptoKey} [masterKey] - 解密密钥，不传则自动获取
 * @returns {Promise<string>} 明文 PEM 字符串
 * @throws {Error} 解密失败（密钥不匹配、数据损坏等）
 */
async function decryptPrivateKey(enc, masterKey) {
    if (!masterKey) masterKey = await getOrCreateMasterKey();

    const iv = base64ToBytes(enc.iv);
    const ciphertext = base64ToBytes(enc.ciphertext);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        masterKey,
        ciphertext
    );

    return bytesToString(new Uint8Array(decrypted));
}