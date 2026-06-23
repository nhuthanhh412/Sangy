import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DataFetcher } from '../notion/fetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Polling Service
 * Periodically fetches data from Notion.
 */
export class PollingService {
    constructor(db, wsServer, getAccessToken) {
        this.db = db;
        this.wsServer = wsServer;
        this.getAccessToken = getAccessToken;
        this.isRunning = false;
        this.isPolling = false;
        this.pollTimer = null;
        this.firstPollTimer = null;
        this.effectiveIntervalMs = null;
    }

    normalizeInterval(intervalMs) {
        const parsed = Number(intervalMs);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return 300000;
        }

        const minMs = 5000;
        const maxMs = 24 * 60 * 60 * 1000;
        return Math.max(minMs, Math.min(maxMs, parsed));
    }

    loadPriorityDatabases() {
        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            if (!fs.existsSync(priorityPath)) return [];

            const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
            if (!Array.isArray(data.priority_databases)) return [];
            return data.priority_databases.filter((id) => typeof id === 'string' && id.trim().length > 0);
        } catch (error) {
            console.warn('[Poller] Could not load whitelist priority databases:', error.message);
            return [];
        }
    }

    mergeTargetDatabases(selectedDatabases = [], priorityDatabases = []) {
        const selected = Array.isArray(selectedDatabases) ? selectedDatabases : [];
        const priority = Array.isArray(priorityDatabases) ? priorityDatabases : [];
        return [...new Set([...priority, ...selected].filter((id) => typeof id === 'string' && id.trim().length > 0))];
    }

    getTargetDatabaseIds() {
        const selectedDatabases = this.db.getConfig('selected_databases') || [];
        const priorityDatabases = this.loadPriorityDatabases();
        const targetDatabases = this.mergeTargetDatabases(selectedDatabases, priorityDatabases);

        return {
            targetDatabases,
            selectedDatabases: Array.isArray(selectedDatabases) ? selectedDatabases : [],
            priorityDatabases
        };
    }

    /**
     * Start polling service.
     * @param {number} intervalMs - Polling interval in milliseconds.
     */
    start(intervalMs = 600000) {
        if (this.isRunning) {
            console.log('[Poller] Already running');
            return;
        }

        this.effectiveIntervalMs = this.normalizeInterval(intervalMs);
        console.log(`[Poller] Starting with interval: requested=${intervalMs}ms, effective=${this.effectiveIntervalMs}ms`);

        const firstPollDelay = 5000;
        console.log(`[Poller] Using cached data first. Background sync starts in ${firstPollDelay / 1000}s`);

        this.firstPollTimer = setTimeout(() => {
            console.log('[Poller] Starting background sync with Notion...');
            this.poll();
        }, firstPollDelay);

        this.pollTimer = setInterval(() => {
            this.poll();
        }, this.effectiveIntervalMs);

        this.isRunning = true;
        console.log('[Poller] Service started');
    }

    /**
     * Perform a single poll operation.
     * Protected by a concurrency guard, so only one poll runs at a time.
     */
    async poll() {
        if (this.isPolling) {
            console.log('[Poller] Poll already in progress, skipping');
            return;
        }
        this.isPolling = true;

        try {
            console.log('[Poller] Starting data fetch');

            const accessToken = this.getAccessToken();
            if (!accessToken) {
                console.log('[Poller] No access token available, skipping poll');
                return;
            }

            const { targetDatabases, selectedDatabases, priorityDatabases } = this.getTargetDatabaseIds();
            if (targetDatabases.length === 0) {
                console.log('[Poller] No selected or whitelisted databases, skipping poll');
                return;
            }

            console.log(
                `[Poller] Poll target: ${targetDatabases.length} databases (${priorityDatabases.length} whitelist priority, ${selectedDatabases.length} selected)`
            );

            const fetcher = new DataFetcher(accessToken, this.db);

            const onBatchComplete = (dbId, recordCount, syncMeta = {}) => {
                if (!this.wsServer) return;
                const savedName = typeof this.db.getDatabaseName === 'function'
                    ? this.db.getDatabaseName(dbId)
                    : null;
                const databaseName = syncMeta.database_name || savedName || `${String(dbId).slice(0, 8)}...`;
                this.wsServer.broadcastUpdate({
                    type: 'progress',
                    message: `Database loaded: ${databaseName}`,
                    database_id: dbId,
                    database_name: databaseName,
                    records_count: recordCount,
                    sync_mode: syncMeta.mode || 'unknown',
                    effective_interval_ms: this.effectiveIntervalMs
                });
            };

            const data = await fetcher.fetchAllData(targetDatabases, onBatchComplete, {
                fullSyncCheckpointMs: parseInt(process.env.FULL_SYNC_CHECKPOINT_MS, 10) || undefined
            });

            const totalRecords = Object.values(data).reduce((sum, rows) => sum + rows.length, 0);
            console.log(`[Poller] Fetch completed: ${totalRecords} total records`);

            if (this.wsServer) {
                this.wsServer.broadcastUpdate({
                    type: 'complete',
                    message: 'Data updated',
                    records_count: totalRecords,
                    databases_count: targetDatabases.length,
                    selected_databases_count: selectedDatabases.length,
                    priority_databases_count: priorityDatabases.length,
                    effective_interval_ms: this.effectiveIntervalMs
                });
            }
        } catch (error) {
            console.error('[Poller] Error during poll:', error);

            if (this.wsServer) {
                this.wsServer.broadcastUpdate({
                    type: 'error',
                    message: 'Failed to fetch data',
                    error: error.message
                });
            }
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Stop polling service.
     */
    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.firstPollTimer) {
            clearTimeout(this.firstPollTimer);
            this.firstPollTimer = null;
        }

        this.isRunning = false;
        console.log('[Poller] Service stopped');
    }

    /**
     * Manually trigger a poll.
     */
    async triggerPoll() {
        console.log('[Poller] Manual poll triggered');
        await this.poll();
    }
}
