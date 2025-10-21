import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempDir = await mkdtemp(path.join(tmpdir(), 'dextmcp-test-'));
const originalDbPath = process.env.TOOLS_DB_PATH;
const originalApiKey = process.env.ADMIN_API_KEY;
const originalAllowUnauth = process.env.ALLOW_UNAUTHENTICATED_API;

process.env.TOOLS_DB_PATH = path.join(tempDir, 'tools.db');
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.ALLOW_UNAUTHENTICATED_API = 'false';

const mcpModule = await import('../mcp-server.js');
const { startHttpServer, stopHttpServer } = mcpModule;

let sqliteSupported = true;
try {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const db = new BetterSqlite3(':memory:');
    db.close();
} catch (error) {
    sqliteSupported = false;
}

test.after(async () => {
    if (originalDbPath !== undefined) {
        process.env.TOOLS_DB_PATH = originalDbPath;
    } else {
        delete process.env.TOOLS_DB_PATH;
    }

    if (originalApiKey !== undefined) {
        process.env.ADMIN_API_KEY = originalApiKey;
    } else {
        delete process.env.ADMIN_API_KEY;
    }

    if (originalAllowUnauth !== undefined) {
        process.env.ALLOW_UNAUTHENTICATED_API = originalAllowUnauth;
    } else {
        delete process.env.ALLOW_UNAUTHENTICATED_API;
    }

    await rm(tempDir, { recursive: true, force: true });
});

if (!sqliteSupported) {
    test('admin API supports CRUD flow and metrics endpoint', (t) => {
        t.skip('better-sqlite3 native binding is unavailable in this environment');
    });
} else {
    test('admin API supports CRUD flow and metrics endpoint', async (t) => {
        const server = startHttpServer({ port: 0 });
        const address = server.address();
        assert.ok(address && typeof address.port === 'number');
        const baseUrl = `http://127.0.0.1:${address.port}`;

        t.after(async () => {
            await stopHttpServer();
        });

        const fetchWithKey = (path, options = {}) => {
            const headers = {
                'x-api-key': 'test-admin-key',
                ...(options.headers || {})
            };
            return fetch(`${baseUrl}${path}`, {
                ...options,
                headers,
            });
        };

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.strictEqual(health.status, 'ok');

    let response = await fetchWithKey('/api/mcp-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name: 'devtools' })
    });
    assert.strictEqual(response.status, 201);
    const createdGroup = await response.json();
    assert.strictEqual(createdGroup.data.group_name, 'devtools');

    response = await fetchWithKey('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            server_name: 'demo-server',
            server_type: 'http',
            url: 'http://example.com/mcp',
            description: 'integration test server',
            group_names: ['devtools']
        })
    });
    assert.strictEqual(response.status, 201);
    const createdServer = await response.json();
    assert.strictEqual(createdServer.data.server_name, 'demo-server');
    assert.deepStrictEqual(createdServer.data.group_names, ['devtools']);

    response = await fetchWithKey('/api/mcp-servers');
    assert.strictEqual(response.status, 200);
    const serverList = await response.json();
    assert.strictEqual(serverList.data.length, 1);

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(metricsResponse.status, 200);
    const metricsBody = await metricsResponse.text();
    assert.ok(metricsBody.includes('http_request_duration_seconds'));
    });
}
