import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAdminAuthenticator,
    createInMemoryRateLimiter,
    secureSessionId
} from '../security.js';

function createMockResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.payload = body;
            return this;
        }
    };
}

test('secureSessionId returns expected length and hex characters', () => {
    const id = secureSessionId(10);
    assert.strictEqual(id.length, 10);
    assert.match(id, /^[0-9a-f]+$/);
});

test('admin authenticator rejects missing API key when required', () => {
    const originalKey = process.env.ADMIN_API_KEY;
    const originalAllow = process.env.ALLOW_UNAUTHENTICATED_API;
    delete process.env.ADMIN_API_KEY;
    process.env.ALLOW_UNAUTHENTICATED_API = 'false';

    const authenticator = createAdminAuthenticator();
    const res = createMockResponse();
    let nextCalled = false;

    authenticator({ headers: {} }, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.payload, { error: 'Admin API disabled: ADMIN_API_KEY is not configured.' });

    if (originalKey !== undefined) {
        process.env.ADMIN_API_KEY = originalKey;
    } else {
        delete process.env.ADMIN_API_KEY;
    }
    if (originalAllow !== undefined) {
        process.env.ALLOW_UNAUTHENTICATED_API = originalAllow;
    } else {
        delete process.env.ALLOW_UNAUTHENTICATED_API;
    }
});

test('admin authenticator accepts valid API key from header', () => {
    const originalKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = 'secret-key';
    const authenticator = createAdminAuthenticator();
    const res = createMockResponse();
    let nextCalled = false;

    authenticator({ headers: { 'x-api-key': 'secret-key' } }, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(nextCalled, true);

    if (originalKey !== undefined) {
        process.env.ADMIN_API_KEY = originalKey;
    } else {
        delete process.env.ADMIN_API_KEY;
    }
});

test('rate limiter blocks after reaching threshold', () => {
    const limiter = createInMemoryRateLimiter({ windowMs: 1_000, max: 2, keyGenerator: () => 'fixed' });

    let nextCalls = 0;
    limiter({}, createMockResponse(), () => { nextCalls += 1; });
    limiter({}, createMockResponse(), () => { nextCalls += 1; });

    const res = createMockResponse();
    limiter({}, res, () => { nextCalls += 1; });

    assert.strictEqual(nextCalls, 2);
    assert.strictEqual(res.statusCode, 429);
    assert.deepStrictEqual(res.payload, { error: 'Too many requests, please slow down.' });
});
