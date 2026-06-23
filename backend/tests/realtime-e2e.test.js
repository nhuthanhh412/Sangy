import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import { RealtimeServer } from '../src/websocket/server.js';
import { PollingService } from '../src/scheduler/poller.js';
import { DataFetcher } from '../src/notion/fetcher.js';

test('realtime E2E: receives websocket progress + complete events from poller', async () => {
    const httpServer = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('ok');
    });

    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const realtimeServer = new RealtimeServer(httpServer);
    const messages = [];

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (raw) => {
        try {
            messages.push(JSON.parse(raw.toString()));
        } catch {
            // ignore
        }
    });
    await new Promise((resolve) => ws.on('open', resolve));

    const db = {
        getConfig: (key) => key === 'selected_databases' ? ['db-1', 'db-2'] : null
    };

    const originalLoadPriorityDatabases = PollingService.prototype.loadPriorityDatabases;
    const originalFetchAllData = DataFetcher.prototype.fetchAllData;
    PollingService.prototype.loadPriorityDatabases = () => [];
    DataFetcher.prototype.fetchAllData = async (_dbIds, onBatchComplete) => {
        onBatchComplete('db-1', 120, { mode: 'incremental_upsert' });
        onBatchComplete('db-2', 95, { mode: 'full_sync_checkpoint' });
        return {
            'db-1': Array.from({ length: 120 }, (_, i) => ({ id: `a-${i}` })),
            'db-2': Array.from({ length: 95 }, (_, i) => ({ id: `b-${i}` }))
        };
    };

    try {
        const poller = new PollingService(db, realtimeServer, () => 'token');
        await poller.poll();

        // Give websocket queue a moment to flush
        await new Promise((resolve) => setTimeout(resolve, 250));

        const progressEvents = messages.filter(m => m.type === 'progress');
        const completeEvents = messages.filter(m => m.type === 'complete');

        assert.ok(progressEvents.length >= 2);
        assert.ok(completeEvents.length >= 1);
        assert.equal(completeEvents[0].databases_count, 2);
    } finally {
        PollingService.prototype.loadPriorityDatabases = originalLoadPriorityDatabases;
        DataFetcher.prototype.fetchAllData = originalFetchAllData;
        ws.close();
        realtimeServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
    }
});
