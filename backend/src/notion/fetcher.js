import { NotionClient } from './client.js';
import debugLog from '../debug_logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Data Fetcher Service
 * Orchestrates fetching data from multiple databases
 */
export class DataFetcher {
    constructor(accessToken, db) {
        this.client = new NotionClient(accessToken);
        this.db = db;
        this.priorityDatabases = this.loadPriorityDatabases();
        debugLog('DataFetcher initialized');
    }

    /**
     * Load priority databases from config file
     * @returns {Array<string>} Array of priority database IDs
     */
    loadPriorityDatabases() {
        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            if (fs.existsSync(priorityPath)) {
                const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
                const priorities = data.priority_databases || [];
                console.log(`[Fetcher] 🌟 Loaded ${priorities.length} priority databases from whitelist`);
                return priorities;
            }
        } catch (error) {
            console.error('[Fetcher] Warning: Could not load priority_projects.json:', error.message);
        }
        return [];
    }

    /**
     * Sort database IDs with priority databases first
     * @param {Array<string>} databaseIds - Array of database IDs
     * @returns {Array<string>} Sorted array with priority DBs first
     */
    sortByPriority(databaseIds) {
        const prioritySet = new Set(this.priorityDatabases);
        const priorityList = [];
        const normalList = [];

        for (const dbId of databaseIds) {
            if (prioritySet.has(dbId)) {
                priorityList.push(dbId);
            } else {
                normalList.push(dbId);
            }
        }

        console.log(`[Fetcher] 📊 Priority order: ${priorityList.length} priority DBs first, then ${normalList.length} others`);
        return [...priorityList, ...normalList];
    }

    /**
     * Fetch data from all selected databases
     * Priority databases are fetched first and saved immediately
     * @param {Array<string>} databaseIds - Array of database IDs to fetch
     * @param {Function} onBatchComplete - Callback when a batch completes (for progressive loading)
     * @param {Object} options - Additional options
     * @param {boolean} options.fullSync - Force full sync (no incremental), always true for single-DB fetches
     * @param {number} options.fullSyncCheckpointMs - Time-based checkpoint for periodic full sync
     * @param {Function} options.shouldCancel - Optional callback that returns true when sync should abort
     * @returns {Promise<Object>} Object with database data keyed by ID
     */
    async fetchAllData(databaseIds, onBatchComplete = null, options = {}) {
        const fullSyncCheckpointMs = Number(options.fullSyncCheckpointMs) > 0
            ? Number(options.fullSyncCheckpointMs)
            : (parseInt(process.env.FULL_SYNC_CHECKPOINT_MS, 10) || 6 * 60 * 60 * 1000);
        const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;

        const ensureNotCancelled = () => {
            if (shouldCancel()) {
                throw new Error('Sync cancelled by user');
            }
        };

        // Deduplicate IDs first
        const uniqueIds = [...new Set(databaseIds)];

        // Sort databases by priority
        const sortedDatabaseIds = this.sortByPriority(uniqueIds);
        const prioritySet = new Set(this.priorityDatabases);

        // Split into priority and normal
        // Split into priority and normal
        // Ensure NO overlapping by strictly filtering
        const priorityDbs = [];
        const normalDbs = [];

        for (const id of sortedDatabaseIds) {
            if (prioritySet.has(id)) {
                priorityDbs.push(id);
            } else {
                normalDbs.push(id);
            }
        }

        console.log(`[Fetcher] Starting to fetch: ${priorityDbs.length} priority DBs first, then ${normalDbs.length} others...`);

        const results = {};
        const dbMetadata = {};

        // Helper sleep function
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // === PHASE 1: Fetch PRIORITY databases first ===
        if (priorityDbs.length > 0) {
            console.log(`[Fetcher] 🌟 PHASE 1: Loading ${priorityDbs.length} priority databases...`);

            for (const dbId of priorityDbs) {
                try {
                    ensureNotCancelled();

                    // Get metadata
                    const dbInfo = await this.client.notion.databases.retrieve({ database_id: dbId });
                    dbMetadata[dbId] = this.extractDatabaseName(dbInfo);
                    await sleep(150);

                    ensureNotCancelled();

                    // Fetch data
                    // Priority DBs also follow incremental + periodic full-sync checkpoint
                    // to avoid stale/ghost records staying in cache.
                    let pages = [];
                    let usedIncremental = false;
                    let usedCheckpointFullSync = false;

                    if (this.db && !options.fullSync) {
                        const lastSync = this.db.getLastSyncTime(dbId);
                        const checkpointDue = this.db.isFullSyncDue(dbId, fullSyncCheckpointMs);

                        if (checkpointDue) {
                            usedCheckpointFullSync = true;
                            // OOM Fix: Limit full sync to 30 days. Historical data is in snapshot.
                            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                            pages = await this.client.getAllPages(dbId, {
                                timestamp: "last_edited_time",
                                last_edited_time: { after: thirtyDaysAgo }
                            });
                        } else if (lastSync) {
                            try {
                                const safetyBuffer = 24 * 60 * 60 * 1000;
                                const safeTime = new Date(new Date(lastSync).getTime() - safetyBuffer).toISOString();
                                const filter = {
                                    timestamp: "last_edited_time",
                                    last_edited_time: { after: safeTime }
                                };
                                pages = await this.client.getAllPages(dbId, filter);
                                usedIncremental = true;
                            } catch (filterError) {
                                // Filter unsupported/fails => fallback to 30 days
                                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                                pages = await this.client.getAllPages(dbId, {
                                    timestamp: "last_edited_time",
                                    last_edited_time: { after: thirtyDaysAgo }
                                });
                            }
                        } else {
                            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                            pages = await this.client.getAllPages(dbId, {
                                timestamp: "last_edited_time",
                                last_edited_time: { after: thirtyDaysAgo }
                            });
                        }
                    } else {
                        // fullSync mode or no DB manager: fetch last 30 days
                        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                        pages = await this.client.getAllPages(dbId, {
                            timestamp: "last_edited_time",
                            last_edited_time: { after: thirtyDaysAgo }
                        });
                    }
                    const databaseName = dbMetadata[dbId];
                    const projectName = this.extractProjectName(databaseName);

                    const transformed = pages.map(page => ({
                        ...this.transformPage(page),
                        database_name: databaseName,
                        project_name: projectName,
                        database_id: dbId
                    }));
                    if (this.db && typeof this.db.setDatabaseName === 'function' && databaseName) {
                        this.db.setDatabaseName(dbId, databaseName);
                    }

                    results[dbId] = transformed;
                    console.log(`[Fetcher] 🌟 Priority: ${dbId.substring(0, 8)}... (${databaseName}): ${transformed.length} records`);

                    // Save immediately to DB if available
                    if (this.db && onBatchComplete) {
                        ensureNotCancelled();
                        let totalCount;
                        let syncMeta = { mode: 'full_sync', new: transformed.length, updated: 0, deleted: 0 };
                        if (options.fullSync || !usedIncremental) {
                            // Full sync or checkpoint: OVERWRITE cache to remove deleted records
                            const prevCount = this.db.getData(dbId)?.length || 0;
                            this.db.saveData(dbId, transformed);
                            totalCount = transformed.length;
                            syncMeta.mode = usedCheckpointFullSync ? 'full_sync_checkpoint' : 'full_sync';
                            syncMeta.deleted = Math.max(0, prevCount - transformed.length);
                        } else {
                            // Incremental: merge into existing cache
                            const stats = this.db.upsertData(dbId, transformed);
                            totalCount = stats ? stats.total : transformed.length;
                            if (stats) syncMeta = { mode: 'incremental_upsert', ...stats, deleted: 0 };
                        }
                        syncMeta.database_name = databaseName;
                        onBatchComplete(dbId, totalCount, syncMeta);
                    }

                    await sleep(250);
                } catch (error) {
                    console.error(`[Fetcher] ❌ Priority DB ${dbId} failed:`, error.message);
                    if (options.failOnDatabaseError) {
                        throw error;
                    }
                    results[dbId] = [];
                }
            }

            const priorityRecords = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
            console.log(`[Fetcher] ✅ PHASE 1 COMPLETE: ${priorityDbs.length} priority DBs, ${priorityRecords} records READY`);
        }

        // === PHASE 2: Fetch NORMAL databases in background ===
        if (normalDbs.length > 0) {
            console.log(`[Fetcher] 📦 PHASE 2: Loading ${normalDbs.length} remaining databases in background...`);

            let normalCount = 0;
            for (const dbId of normalDbs) {
                try {
                    ensureNotCancelled();

                    // Get metadata
                    const dbInfo = await this.client.notion.databases.retrieve({ database_id: dbId });
                    dbMetadata[dbId] = this.extractDatabaseName(dbInfo);
                    await sleep(150);

                    // Try incremental sync first ONLY if not fullSync mode, fallback to full sync
                    let pages = [];
                    let usedIncremental = false;
                    let usedCheckpointFullSync = false;

                    if (this.db && !options.fullSync) {
                        const lastSync = this.db.getLastSyncTime(dbId);
                        const checkpointDue = this.db.isFullSyncDue(dbId, fullSyncCheckpointMs);
                        if (checkpointDue) {
                            usedCheckpointFullSync = true;
                            pages = await this.client.getAllPages(dbId);
                        } else if (lastSync) {
                            try {
                                const safetyBuffer = 24 * 60 * 60 * 1000;
                                const safeTime = new Date(new Date(lastSync).getTime() - safetyBuffer).toISOString();
                                const filter = {
                                    timestamp: "last_edited_time",
                                    last_edited_time: { after: safeTime }
                                };
                                pages = await this.client.getAllPages(dbId, filter);
                                usedIncremental = true;
                            } catch (filterError) {
                                // Filter failed (property not found), do full sync
                                pages = await this.client.getAllPages(dbId);
                            }
                        } else {
                            pages = await this.client.getAllPages(dbId);
                        }
                    } else {
                        // fullSync mode or no DB: always fetch ALL records
                        pages = await this.client.getAllPages(dbId);
                    }

                    const databaseName = dbMetadata[dbId];
                    const projectName = this.extractProjectName(databaseName);

                    const transformed = pages.map(page => ({
                        ...this.transformPage(page),
                        database_name: databaseName,
                        project_name: projectName,
                        database_id: dbId
                    }));
                    if (this.db && typeof this.db.setDatabaseName === 'function' && databaseName) {
                        this.db.setDatabaseName(dbId, databaseName);
                    }

                    results[dbId] = transformed;
                    normalCount++;

                    // Save immediately to DB if available
                    if (this.db && onBatchComplete) {
                        ensureNotCancelled();
                        let totalCount;
                        let syncMeta = { mode: 'full_sync', new: transformed.length, updated: 0, deleted: 0 };
                        if (options.fullSync || !usedIncremental) {
                            // Full sync or first-time fetch: OVERWRITE cache
                            const prevCount = this.db.getData(dbId)?.length || 0;
                            this.db.saveData(dbId, transformed);
                            totalCount = transformed.length;
                            syncMeta.mode = usedCheckpointFullSync ? 'full_sync_checkpoint' : 'full_sync';
                            syncMeta.deleted = Math.max(0, prevCount - transformed.length);
                        } else {
                            // Incremental: merge into existing cache
                            const stats = this.db.upsertData(dbId, transformed);
                            totalCount = stats ? stats.total : transformed.length;
                            if (stats) syncMeta = { mode: 'incremental_upsert', ...stats, deleted: 0 };
                        }
                        syncMeta.database_name = databaseName;
                        onBatchComplete(dbId, totalCount, syncMeta);
                    }

                    // Log progress every 10 databases
                    if (normalCount % 10 === 0) {
                        console.log(`[Fetcher] 📦 Progress: ${normalCount}/${normalDbs.length} normal DBs loaded`);
                    }

                    await sleep(300);
                } catch (error) {
                    console.error(`[Fetcher] ❌ Normal DB ${dbId} failed:`, error.message);
                    if (options.failOnDatabaseError) {
                        throw error;
                    }
                    results[dbId] = [];
                }
            }

            console.log(`[Fetcher] ✅ PHASE 2 COMPLETE: ${normalCount} normal DBs loaded`);
        }

        const totalRecords = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[Fetcher] ✅ ALL SYNC COMPLETE: ${Object.keys(results).length} databases, ${totalRecords} total records`);

        return results;
    }

    extractDatabaseName(database) {
        if (database.title && database.title.length > 0) {
            return database.title[0].plain_text || 'Untitled Database';
        }
        return 'Untitled Database';
    }

    /**
     * Extract project name from database name by removing suffix
     * @param {string} databaseName - Full database name
     * @returns {string} Project name without suffix
     */
    extractProjectName(databaseName) {
        // Patterns to remove: " - Product", " - Task", " - Sprint", "_Product", etc.
        const patterns = [
            / - Product$/i,
            / - Task$/i,
            / - Sprint$/i,
            /_Product$/i,
            /_Task$/i,
            /_Sprint$/i,
            /Product$/i,
            /Task$/i,
            /Sprint$/i
        ];

        let projectName = databaseName;
        for (const pattern of patterns) {
            projectName = projectName.replace(pattern, '').trim();
        }

        // Remove trailing dash or underscore if any
        projectName = projectName.replace(/[-_\s]+$/, '').trim();

        return projectName || databaseName;
    }

    /**
     * Transform Notion page to simplified format
     * @param {Object} page - Notion page object
     * @returns {Object} Simplified page data
     */
    transformPage(page) {
        const transformed = {
            id: page.id,
            created_time: page.created_time,
            last_edited_time: page.last_edited_time,
            properties: {}
        };

        // Transform properties to simple key-value pairs
        for (const [key, prop] of Object.entries(page.properties)) {
            const value = this.extractPropertyValue(prop);
            transformed.properties[key] = value;

            // Store explicit title for lookup reliability
            if (prop.type === 'title') {
                transformed._title = value;
            }
        }

        return transformed;
    }

    /**
     * Extract value from Notion property based on type
     * @param {Object} property - Notion property object
     * @returns {any} Extracted value
     */
    extractPropertyValue(property) {
        const type = property.type;

        switch (type) {
            case 'title':
                return property.title?.map(t => t.plain_text).join('') || '';

            case 'rich_text':
                return property.rich_text?.map(t => t.plain_text).join('') || '';

            case 'number':
                return property.number;

            case 'select':
                return property.select?.name || null;

            case 'multi_select':
                return property.multi_select?.map(s => s.name) || [];

            case 'date':
                return property.date ? {
                    start: property.date.start,
                    end: property.date.end
                } : null;

            case 'people':
                return property.people?.map(p => ({
                    id: p.id,
                    name: p.name || p.person?.email || 'Unknown User',
                    email: p.person?.email || null
                })) || [];

            case 'checkbox':
                return property.checkbox;

            case 'url':
                return property.url;

            case 'email':
                return property.email;

            case 'phone_number':
                return property.phone_number;

            case 'status':
                return property.status?.name || null;

            case 'relation':
                return property.relation?.map(r => r.id) || [];

            case 'formula':
                return this.extractFormulaValue(property.formula);

            case 'rollup':
                return this.extractRollupValue(property.rollup);

            default:
                return null;
        }
    }

    /**
     * Extract value from formula property
     */
    extractFormulaValue(formula) {
        if (!formula) return null;

        switch (formula.type) {
            case 'string':
                return formula.string;
            case 'number':
                return formula.number;
            case 'boolean':
                return formula.boolean;
            case 'date':
                return formula.date;
            default:
                return null;
        }
    }

    /**
     * Extract value from rollup property
     */
    extractRollupValue(rollup) {
        if (!rollup) return null;

        switch (rollup.type) {
            case 'number':
                return rollup.number;
            case 'array':
                // Process array items to extract meaningful values
                if (!rollup.array || rollup.array.length === 0) return null;

                return rollup.array.map(item => {
                    if (!item) return null;

                    // Title type (from relation title rollup)
                    if (item.type === 'title' && item.title) {
                        return item.title.map(t => t.plain_text || '').join('');
                    }
                    // Rich text
                    if (item.type === 'rich_text' && item.rich_text) {
                        return item.rich_text.map(t => t.plain_text || '').join('');
                    }
                    // Select/Status
                    if (item.type === 'select' && item.select) {
                        return item.select.name;
                    }
                    if (item.type === 'status' && item.status) {
                        return item.status.name;
                    }
                    // Number
                    if (item.type === 'number') {
                        return item.number;
                    }
                    // Date
                    if (item.type === 'date' && item.date) {
                        return item.date.start || item.date.end;
                    }
                    // Formula
                    if (item.type === 'formula' && item.formula) {
                        return item.formula.string ?? item.formula.number ?? item.formula.boolean ?? null;
                    }

                    return item;
                }).filter(v => v !== null);
            default:
                return null;
        }
    }
}
