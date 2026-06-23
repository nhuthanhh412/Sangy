import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { DatabaseManager } from '../src/database/db.js';
import { DataFetcher } from '../src/notion/fetcher.js';

function makePage(id, title) {
    return {
        id,
        created_time: '2026-02-24T00:00:00.000Z',
        last_edited_time: '2026-02-24T00:00:00.000Z',
        properties: {
            Name: {
                type: 'title',
                title: [{ plain_text: title }]
            }
        }
    };
}

test('incremental + deletion is reconciled by full-sync checkpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sync-correctness-'));
    try {
        const db = new DatabaseManager(tempDir);
        const dbId = 'db-sync-test';
        const fetcher = new DataFetcher('unit-test-token', db);
        const events = [];
        let phase = 1;

        fetcher.client.notion.databases.retrieve = async () => ({ title: [{ plain_text: 'Task DB' }] });
        fetcher.client.getAllPages = async (_dbId, filter = undefined) => {
            if (phase === 1) {
                return [makePage('task-1', 'Task 1'), makePage('task-2', 'Task 2')];
            }

            if (phase === 2) {
                // incremental with filter: no changed pages
                if (filter) return [];
                return [makePage('task-1', 'Task 1'), makePage('task-2', 'Task 2')];
            }

            // checkpoint full-sync: task-1 was deleted in source
            return [makePage('task-2', 'Task 2')];
        };

        const onBatch = (id, count, meta = {}) => {
            events.push({ id, count, meta });
        };

        // Phase 1: initial full sync (2 tasks)
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: true });
        assert.equal(db.getData(dbId).length, 2);

        // Phase 2: incremental (no changed records), cache still keeps both tasks
        phase = 2;
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: false, fullSyncCheckpointMs: 24 * 60 * 60 * 1000 });
        assert.equal(db.getData(dbId).length, 2);

        // Force checkpoint due by backdating full_sync_times
        const fullSyncTimes = db.getMetadata('full_sync_times') || {};
        fullSyncTimes[dbId] = '2020-01-01T00:00:00.000Z';
        db.setMetadata('full_sync_times', fullSyncTimes);

        // Phase 3: checkpoint full-sync should prune deleted task-1
        phase = 3;
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: false, fullSyncCheckpointMs: 1 });
        const finalData = db.getData(dbId);

        assert.equal(finalData.length, 1);
        assert.equal(finalData[0].id, 'task-2');

        const lastEvent = events[events.length - 1];
        assert.equal(lastEvent.meta.mode, 'full_sync_checkpoint');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('priority databases also reconcile deletion via full-sync checkpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sync-priority-'));
    try {
        const db = new DatabaseManager(tempDir);
        const dbId = 'db-priority-test';
        const fetcher = new DataFetcher('unit-test-token', db);
        fetcher.priorityDatabases = [dbId];
        const events = [];
        let phase = 1;

        fetcher.client.notion.databases.retrieve = async () => ({ title: [{ plain_text: 'Priority Task DB' }] });
        fetcher.client.getAllPages = async (_dbId, filter = undefined) => {
            if (phase === 1) {
                return [makePage('task-1', 'Task 1'), makePage('task-2', 'Task 2')];
            }

            if (phase === 2) {
                // incremental with filter: no changed pages
                if (filter) return [];
                return [makePage('task-1', 'Task 1'), makePage('task-2', 'Task 2')];
            }

            // checkpoint full-sync: task-1 deleted in source
            return [makePage('task-2', 'Task 2')];
        };

        const onBatch = (id, count, meta = {}) => {
            events.push({ id, count, meta });
        };

        // Phase 1: initial full sync
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: true });
        assert.equal(db.getData(dbId).length, 2);

        // Phase 2: incremental priority sync (should not prune yet)
        phase = 2;
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: false, fullSyncCheckpointMs: 24 * 60 * 60 * 1000 });
        assert.equal(db.getData(dbId).length, 2);

        // Force checkpoint due
        const fullSyncTimes = db.getMetadata('full_sync_times') || {};
        fullSyncTimes[dbId] = '2020-01-01T00:00:00.000Z';
        db.setMetadata('full_sync_times', fullSyncTimes);

        // Phase 3: checkpoint full-sync should prune deleted record
        phase = 3;
        await fetcher.fetchAllData([dbId], onBatch, { fullSync: false, fullSyncCheckpointMs: 1 });
        const finalData = db.getData(dbId);

        assert.equal(finalData.length, 1);
        assert.equal(finalData[0].id, 'task-2');

        const lastEvent = events[events.length - 1];
        assert.equal(lastEvent.meta.mode, 'full_sync_checkpoint');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
