const crypto = require('crypto');

const SCALE = 100000000n;
const MAX_UNITS = (1n << 63n) - 1n;
const MAX_HASH = (1n << 256n) - 1n;

// Never round consensus amounts. Both decimal JSON strings and finite numbers
// are accepted, with at most eight decimal places and a bounded supply.
function toUnits(value) {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('金额必须是数字');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('金额必须有限');
    let text = String(value);
    const exponent = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
    if (exponent) {
        const digits = exponent[1] + (exponent[2] || '');
        const point = exponent[1].length + Number(exponent[3]);
        if (point < -8 || point > 20) throw new Error('金额超出范围或精度');
        text = point <= 0 ? '0.' + '0'.repeat(-point) + digits
            : point >= digits.length ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point);
    }
    if (!/^\d{1,20}(?:\.\d{1,8})?$/.test(text)) throw new Error('金额必须非负且最多八位小数');
    const [whole, fraction = ''] = text.split('.');
    const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
    if (units > MAX_UNITS) throw new Error('金额超出范围');
    return units;
}

function fromUnits(units) { return Number(units) / Number(SCALE); }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function transactionPayload(tx) {
    return JSON.stringify([
        'StarCoin/transaction', tx.version, tx.chainId, tx.from, tx.to,
        toUnits(tx.amount).toString(), toUnits(tx.fee).toString(),
        tx.currency, tx.nonce ?? null, tx.note, tx.timestamp, tx.blockHeight ?? null
    ]);
}

// Rational interpolation between consecutive powers of 16 is monotone,
// including the integer boundary. No floating-point arithmetic on the target.
function targetForDifficulty(difficulty, legacy = false) {
    if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 63) throw new Error('无效难度');
    const whole = Math.floor(difficulty);
    const fraction = difficulty - whole;
    const base = 1n << BigInt(256 - whole * 4);
    if (legacy && fraction > 0) {
        const limit = Math.max(0, Math.min(255, Math.floor(fraction * 256)));
        return (base * BigInt(limit) / 256n) - 1n;
    }
    const part = BigInt(Math.round(fraction * 10000));
    return (base * 10000n / (10000n + 15n * part)) - 1n;
}

function meetsTarget(hashHex, target) {
    return typeof hashHex === 'string' && /^[0-9a-f]{64}$/.test(hashHex)
        && target >= 0n && BigInt('0x' + hashHex) <= target;
}

function targetHex(target) { return target.toString(16).padStart(64, '0'); }
function workForTarget(target) { return (1n << 256n) / (target + 1n); }

module.exports = { SCALE, MAX_UNITS, MAX_HASH, toUnits, fromUnits, hash,
    transactionPayload, targetForDifficulty, meetsTarget, targetHex, workForTarget };
