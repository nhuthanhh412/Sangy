import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import session from 'express-session';

import { setupRoutes } from '../src/api/routes.js';
import { buildFreshnessContract } from '../src/utils/freshness.js';
import { DatabaseManager } from '../src/database/db.js';
import { PollingService } from '../src/scheduler/poller.js';

function createMockDb() {
    return {
        setConfig: () => { },
        getConfig: () => [],
        getData: () => [],
        saveData: () => { },
        upsertData: () => ({ total: 0, new: 0, updated: 0, deleted: 0 }),
        getAllData: () => ({}),
        getSelectedData: () => ({}),
        getStats: () => ({ cacheFiles: [], databases: 0, totalRecords: 0 }),
        getLastSyncTime: () => null,
        getLastUpdate: () => new Date().toISOString(),
        getLookupMaps: () => ({ lookupMap: new Map(), userMap: new Map() }),
        buildLookupCache: () => { },
        setNotionCount: () => { },
        getNotionCount: () => null,
        setDatabaseName: () => { },
        getDatabaseName: () => null,
        isFullSyncDue: () => true,
        getMetadata: () => ({}),
        setMetadata: () => { }
    };
}

async function withServer(envOverrides, run, dbOverride = null) {
    const savedEnv = {
        NOTION_TOKEN: process.env.NOTION_TOKEN,
        NOTION_ACCESS_TOKEN: process.env.NOTION_ACCESS_TOKEN
    };
    process.env.NOTION_TOKEN = envOverrides.NOTION_TOKEN ?? '';
    process.env.NOTION_ACCESS_TOKEN = envOverrides.NOTION_ACCESS_TOKEN ?? '';

    const app = express();
    app.use(express.json());
    app.use(session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: true
    }));

    const db = dbOverride || createMockDb();
    const poller = { triggerPoll: async () => { }, effectiveIntervalMs: 300000 };
    setupRoutes(app, db, poller);

    const server = app.listen(0);
    try {
        const port = server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;
        await run(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        process.env.NOTION_TOKEN = savedEnv.NOTION_TOKEN;
        process.env.NOTION_ACCESS_TOKEN = savedEnv.NOTION_ACCESS_TOKEN;
    }
}

test('freshness contract exposes canonical + backward compatible fields', () => {
    const fresh = buildFreshnessContract({
        freshness_status: 'fresh_empty',
        data_source: 'notion_api',
        synced_at: '2026-02-24T00:00:00.000Z'
    });

    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.freshness_status, 'fresh_empty');
    assert.equal(fresh.data_source, 'notion_api');
    assert.equal(fresh.source, 'notion_api');
    assert.equal(fresh.synced_at, '2026-02-24T00:00:00.000Z');
});

test('auth status separates token configured vs session authenticated', async () => {
    await withServer({ NOTION_TOKEN: 'unit-test-token' }, async (baseUrl) => {
        const before = await fetch(`${baseUrl}/auth/status`);
        const beforeStatus = await before.json();
        assert.equal(beforeStatus.configured, true);
        assert.equal(beforeStatus.session_authenticated, false);

        const setupResp = await fetch(`${baseUrl}/auth/setup`, { method: 'POST' });
        assert.equal(setupResp.status, 200);
        const cookie = setupResp.headers.get('set-cookie');
        assert.ok(cookie);

        const after = await fetch(`${baseUrl}/auth/status`, {
            headers: { Cookie: cookie.split(';')[0] }
        });
        const afterStatus = await after.json();
        assert.equal(afterStatus.configured, true);
        assert.equal(afterStatus.session_authenticated, true);
    });
});

test('database manager marks full sync checkpoints', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-notion-db-'));
    try {
        const db = new DatabaseManager(tempDir);
        const dbId = 'test-db';
        assert.equal(db.isFullSyncDue(dbId, 60_000), true);

        db.saveData(dbId, [{ id: '1', properties: {} }]);
        assert.equal(db.isFullSyncDue(dbId, 60_000), false);
        assert.ok(db.getLastFullSyncTime(dbId));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('poller normalizes interval and exposes effective interval', () => {
    const poller = new PollingService(
        { getConfig: () => [], getLastSyncTime: () => null },
        null,
        () => null
    );

    assert.equal(poller.normalizeInterval(1000), 5000);
    assert.equal(poller.normalizeInterval(10 * 60 * 1000), 10 * 60 * 1000);
    assert.equal(poller.normalizeInterval(99 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
    assert.deepEqual(
        poller.mergeTargetDatabases(['db-selected-1', 'db-shared'], ['db-priority-1', 'db-shared']),
        ['db-priority-1', 'db-shared', 'db-selected-1']
    );
});
