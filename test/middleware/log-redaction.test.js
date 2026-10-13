const redact = require('../../src/logger/redact');
const { createErrorMiddleware } = require('../../src/routes/error-handler');
describe('wallet secret logging', () => {
    it('redacts nested credentials, PEM text, bearer headers and URL credentials', () => {
        const original = { mnemonic: 'secret words', credentials: { privateKeyPem: 'secret key', passphrase: 'password' },
            headers: { Authorization: 'Bearer abc', Cookie: 'secret' }, message: 'Bearer abc',
            pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', url: '/api?mnemonic=secret&passphrase=abc' };
        const result = JSON.stringify(redact(original));
        for (const secret of ['secret words', 'secret key', 'Bearer abc', 'mnemonic=secret', 'passphrase=abc', '\\nabc']) expect(result).not.toContain(secret);
        expect(original.mnemonic).toBe('secret words');
    });
    it('does not include invalid JSON body samples or stacks in HTTP errors', () => {
        const error = new SyntaxError('input contains private wallet material'); error.status = 400; error.body = 'secret';
        const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
        createErrorMiddleware({ logErrors: false })(error, {}, res, () => {});
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('wallet material');
        expect(res.json.mock.calls[0][0].stack).toBeUndefined();
    });
});
