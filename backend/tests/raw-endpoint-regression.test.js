import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { setupRoutes } from '../src/api/routes.js';
import { DataFetcher } from '../src/notion/fetcher.js';
import { DatabaseDiscovery } from '../src/notion/discovery.js';

function createInMemoryDb(seed = {}) {
    const store = {
        data: { ...(seed.data || {}) },
        config: { ...(seed.config || {}) },
        metadata: {
            sync_times: {},
            ...seed.metadata
        }
    };

    return {
        setConfig: (k, v) => { store.config[k] = v; },
        getConfig: (k) => store.config[k],
        getData: (id) => store.data[id] || [],
        saveData: (id, rows) => {
            store.data[id] = rows;
            store.metadata.sync_times[id] = new Date().toISOString();
            store.metadata.last_refresh = new Date().toISOString();
        },
        upsertData: (id, rows) => {
            const existing = store.data[id] || [];
            const map = new Map(existing.map(r => [r.id, r]));
            rows.forEach(r => map.set(r.id, r));
            store.data[id] = [...map.values()];
            store.metadata.sync_times[id] = new Date().toISOString();
            store.metadata.last_refresh = new Date().toISOString();
            return { total: store.data[id].length, new: rows.length, updated: 0, deleted: 0 };
        },
        getAllData: () => store.data,
        getSelectedData: () => store.data,
        getStats: () => ({
            cacheFiles: Object.entries(store.data).map(([id, arr]) => ({ id, records: arr.length })),
            databases: Object.keys(store.data).length,
            totalRecords: Object.values(store.data).reduce((sum, arr) => sum + arr.length, 0)
        }),
        getLastSyncTime: (id) => store.metadata.sync_times[id] || null,
        getLastUpdate: () => store.metadata.last_refresh || null,
        getLookupMaps: () => ({ lookupMap: new Map(), userMap: new Map() }),
        buildLookupCache: () => { },
        setNotionCount: () => { },
        getNotionCount: () => null,
        setDatabaseName: () => { },
        getDatabaseName: () => null,
        getMetadata: (k) => store.metadata[k],
        setMetadata: (k, v) => { store.metadata[k] = v; },
        isFullSyncDue: () => false
    };
}

async function withServer({ db, token = 'test-token' }, run) {
    const savedToken = process.env.NOTION_TOKEN;
    const savedAccessToken = process.env.NOTION_ACCESS_TOKEN;
    process.env.NOTION_TOKEN = token;
    process.env.NOTION_ACCESS_TOKEN = token;

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
    const poller = { triggerPoll: async () => { }, effectiveIntervalMs: 300000 };
    setupRoutes(app, db, poller);

    const server = app.listen(0);
    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        await run(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        process.env.NOTION_TOKEN = savedToken;
        process.env.NOTION_ACCESS_TOKEN = savedAccessToken;
    }
}

test('fresh empty response is explicit and does not fallback to stale cache', async () => {
    const db = createInMemoryDb({
        data: { 'db-1': [{ id: 'old', properties: { Name: 'Old Task' } }] },
        metadata: { full_sync_times: { 'db-1': '2020-01-01T00:00:00.000Z' } }
    });
    const originalDiscover = DatabaseDiscovery.prototype.discoverDatabases;
    const originalFetchAllData = DataFetcher.prototype.fetchAllData;

    DatabaseDiscovery.prototype.discoverDatabases = async () => [];
    DataFetcher.prototype.fetchAllData = async () => ({ 'db-1': [] });

    try {
        await withServer({ db }, async (baseUrl) => {
            const resp = await fetch(`${baseUrl}/api/database/db-1/raw?refresh=true`);
            const body = await resp.json();

            assert.equal(resp.status, 200);
            assert.equal(body.success, true);
            assert.equal(body.freshness.freshness_status, 'fresh_empty');
            assert.equal(body.total_records, 0);
            assert.deepEqual(body.data, []);
            assert.equal(body.from_cache, false);
        });
    } finally {
        DatabaseDiscovery.prototype.discoverDatabases = originalDiscover;
        DataFetcher.prototype.fetchAllData = originalFetchAllData;
    }
});

test('fallback-on-error keeps cache but includes stale_reason metadata', async () => {
    const db = createInMemoryDb({
        data: {
            'db-2': [{ id: 'task-1', properties: { Name: 'Cached Task', Status: 'In Progress' } }]
        },
        metadata: { sync_times: { 'db-2': '2026-02-24T00:00:00.000Z' } }
    });
    const originalDiscover = DatabaseDiscovery.prototype.discoverDatabases;
    const originalFetchAllData = DataFetcher.prototype.fetchAllData;

    DatabaseDiscovery.prototype.discoverDatabases = async () => [];
    DataFetcher.prototype.fetchAllData = async () => {
        throw new Error('Notion timeout');
    };

    try {
        await withServer({ db }, async (baseUrl) => {
            const resp = await fetch(`${baseUrl}/api/database/db-2/raw?refresh=true`);
            const body = await resp.json();

            assert.equal(resp.status, 200);
            assert.equal(body.success, true);
            assert.equal(body.freshness.freshness_status, 'fetch_failed_fallback_cache');
            assert.equal(body.freshness.data_source, 'local_cache_fallback');
            assert.match(body.stale_reason, /Notion timeout/);
            assert.equal(body.total_records, 1);
        });
    } finally {
        DatabaseDiscovery.prototype.discoverDatabases = originalDiscover;
        DataFetcher.prototype.fetchAllData = originalFetchAllData;
    }
});

test('load benchmark raw endpoint (cold vs hot cache) with pagination/filter/sort', async () => {
    const rows = Array.from({ length: 6000 }).map((_, i) => ({
        id: `task-${i + 1}`,
        properties: {
            Name: `Task ${i + 1}`,
            Assignee: i % 2 === 0 ? 'Alice' : 'Bob',
            Status: i % 3 === 0 ? 'Done' : 'In Progress'
        }
    }));

    const db = createInMemoryDb({
        data: { 'db-bench': rows },
        metadata: {
            sync_times: { 'db-bench': '2026-02-24T00:00:00.000Z' },
            full_sync_times: { 'db-bench': new Date().toISOString() }
        }
    });

    const originalDiscover = DatabaseDiscovery.prototype.discoverDatabases;
    DatabaseDiscovery.prototype.discoverDatabases = async () => [];

    try {
        await withServer({ db }, async (baseUrl) => {
            const pathQuery = '/api/database/db-bench/raw?limit=200&page=1&sort_by=Name&sort_dir=desc&search=Task&resolve_relations=false';

            const t0 = performance.now();
            const r1 = await fetch(`${baseUrl}${pathQuery}`);
            const b1 = await r1.json();
            const coldMs = performance.now() - t0;

            const t1 = performance.now();
            const r2 = await fetch(`${baseUrl}${pathQuery}`);
            const b2 = await r2.json();
            const hotMs = performance.now() - t1;

            assert.equal(r1.status, 200);
            assert.equal(r2.status, 200);
            assert.equal(b1.pagination.limit, 200);
            assert.equal(b2.pagination.limit, 200);
            assert.ok(b1.total_records >= 6000);
            assert.ok(b1.total_filtered >= 6000);
            assert.ok(hotMs <= coldMs * 2.5);

            const artifactsDir = path.join(process.cwd(), 'tests', 'artifacts');
            fs.mkdirSync(artifactsDir, { recursive: true });
            fs.writeFileSync(
                path.join(artifactsDir, 'raw_load_benchmark.json'),
                JSON.stringify({
                    executed_at: new Date().toISOString(),
                    cold_ms: Math.round(coldMs),
                    hot_ms: Math.round(hotMs),
                    total_records: b1.total_records,
                    total_filtered: b1.total_filtered,
                    page_size: b1.pagination.limit
                }, null, 2),
                'utf8'
            );
        });
    } finally {
        DatabaseDiscovery.prototype.discoverDatabases = originalDiscover;
    }
});

