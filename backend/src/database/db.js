import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'fs';
import debugLog from '../debug_logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * JSON File Database Manager - Split File Version
 * 
 * Cấu trúc thư mục:
 * backend/data/
 * ├── config.json      - Cấu hình (selected_databases, access_token, etc.)
 * ├── metadata.json    - Metadata (sync_times, last_refresh)
 * └── cache/
 *     ├── {database_id_1}.json
 *     ├── {database_id_2}.json
 *     └── ...
 * 
 * Ưu điểm:
 * - Load nhanh hơn (chỉ đọc DB cần thiết)
 * - Sync từng DB riêng lẻ
 * - Dễ backup/chuyển máy (copy folder data/)
 * - File nhỏ, dễ quản lý
 */
export class DatabaseManager {
    constructor(dataDir = null) {
        // Data directory
        const defaultDataDir = join(__dirname, '..', '..', 'data');
        this.dataDir = dataDir || process.env.DATA_DIR || defaultDataDir;

        // File paths
        this.configPath = join(this.dataDir, 'config.json');
        this.metadataPath = join(this.dataDir, 'metadata.json');
        this.cacheDir = join(this.dataDir, 'cache');

        // Legacy path for migration
        this.legacyPath = join(this.dataDir, 'cache.json');

        // In-memory lookup caches for fast relation/user resolution
        this._lookupMapCache = null;
        this._userMapCache = null;
        this._lookupCacheBuiltAt = null;

        // Ensure directories exist
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }

        // Initialize config if doesn't exist
        if (!existsSync(this.configPath)) {
            this._writeJson(this.configPath, {});
        }

        // Initialize metadata if doesn't exist
        if (!existsSync(this.metadataPath)) {
            this._writeJson(this.metadataPath, { sync_times: {} });
        }

        // Auto-migrate from legacy format if exists
        this._migrateFromLegacy();

        // Pre-build lookup cache on startup
        this._buildLookupCacheAsync();

        console.log(`[Database] ✅ Initialized (Split-file mode)`);
        console.log(`[Database]    Config: ${this.configPath}`);
        console.log(`[Database]    Cache:  ${this.cacheDir}`);
    }

    // ==================== PRIVATE HELPERS ====================

    /**
     * Read JSON file safely
     * On parse error, backs up the corrupted file for debugging
     */
    _readJson(filePath, defaultValue = {}) {
        try {
            if (!existsSync(filePath)) {
                return defaultValue;
            }
            const content = readFileSync(filePath, 'utf8');
            return JSON.parse(content);
        } catch (error) {
            console.error(`[Database] ❌ Error reading ${filePath}:`, error.message);
            debugLog(`Error reading ${filePath}: ${error.message}`);
            // Backup corrupted file for post-mortem debugging
            try {
                const backupPath = filePath + '.corrupted.' + Date.now();
                if (existsSync(filePath)) {
                    renameSync(filePath, backupPath);
                    console.error(`[Database] 💾 Corrupted file backed up to: ${backupPath}`);
                }
            } catch (backupErr) {
                console.error(`[Database] Failed to backup corrupted file:`, backupErr.message);
            }
            return defaultValue;
        }
    }

    /**
     * Write JSON file safely using atomic write (temp file + rename)
     * Prevents data corruption if process crashes mid-write
     */
    _writeJson(filePath, data) {
        const tmpPath = filePath + '.tmp';
        try {
            writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
            renameSync(tmpPath, filePath);
        } catch (error) {
            console.error(`[Database] Error writing ${filePath}:`, error.message);
            debugLog(`Error writing ${filePath}: ${error.message}`);
            // Clean up temp file if rename failed
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch (_) { }
        }
    }

    /**
     * Get cache file path for a database
     */
    _getCacheFilePath(databaseId) {
        // Sanitize database ID for filename
        const safeId = databaseId.replace(/[^a-zA-Z0-9-]/g, '_');
        return join(this.cacheDir, `${safeId}.json`);
    }

    /**
     * Migrate from legacy single-file format
     */
    _migrateFromLegacy() {
        if (!existsSync(this.legacyPath)) {
            return;
        }

        // Check if already migrated (cache folder has files)
        try {
            const existingFiles = readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));
            if (existingFiles.length > 0) {
                debugLog('Migration skipped: cache folder already has data');
                return;
            }
        } catch (e) {
            // Continue with migration
        }

        try {
            console.log('[Database] 🔄 Migrating from legacy format...');

            const legacyData = this._readJson(this.legacyPath, null);
            if (!legacyData) {
                console.log('[Database] Legacy file empty or invalid, skipping migration');
                return;
            }

            let migratedCount = 0;

            // Migrate config
            if (legacyData.config && Object.keys(legacyData.config).length > 0) {
                const existingConfig = this._readJson(this.configPath, {});
                const mergedConfig = { ...existingConfig, ...legacyData.config };
                this._writeJson(this.configPath, mergedConfig);
                console.log('[Database]    ✅ Config migrated');
            }

            // Migrate metadata
            if (legacyData.metadata) {
                const existingMeta = this._readJson(this.metadataPath, {});
                const mergedMeta = { ...existingMeta, ...legacyData.metadata };
                this._writeJson(this.metadataPath, mergedMeta);
                console.log('[Database]    ✅ Metadata migrated');
            }

            // Migrate data_cache (split into individual files)
            if (legacyData.data_cache) {
                for (const [dbId, records] of Object.entries(legacyData.data_cache)) {
                    if (Array.isArray(records) && records.length > 0) {
                        const cacheFile = this._getCacheFilePath(dbId);
                        this._writeJson(cacheFile, records);
                        migratedCount++;
                    }
                }
                console.log(`[Database]    ✅ ${migratedCount} databases migrated to split files`);
            }

            // Rename legacy file to backup (don't delete)
            const backupPath = join(this.dataDir, 'cache_legacy_backup.json');
            if (!existsSync(backupPath)) {
                renameSync(this.legacyPath, backupPath);
                console.log('[Database]    ✅ Legacy file renamed to cache_legacy_backup.json');
            }

            console.log('[Database] ✅ Migration completed!');
        } catch (error) {
            console.error('[Database] ❌ Migration error:', error.message);
            debugLog(`Migration error: ${error.message}`);
        }
    }

    // ==================== CONFIG METHODS ====================

    /**
     * Save configuration
     * @param {string} key
     * @param {any} value
     */
    setConfig(key, value) {
        const config = this._readJson(this.configPath, {});
        config[key] = value;
        this._writeJson(this.configPath, config);
        debugLog(`Config set: ${key}`);
    }

    /**
     * Get configuration
     * @param {string} key
     * @returns {any}
     */
    getConfig(key) {
        const config = this._readJson(this.configPath, {});
        return config[key];
    }

    /**
     * Get all config
     */
    getAllConfig() {
        return this._readJson(this.configPath, {});
    }

    // ==================== METADATA METHODS ====================

    /**
     * Save metadata
     * @param {string} key
     * @param {any} value
     */
    setMetadata(key, value) {
        const metadata = this._readJson(this.metadataPath, {});
        metadata[key] = value;
        this._writeJson(this.metadataPath, metadata);
    }

    /**
     * Get metadata
     * @param {string} key
     * @returns {any}
     */
    getMetadata(key) {
        const metadata = this._readJson(this.metadataPath, {});
        return metadata[key];
    }

    /**
     * Get last sync time for a database
     */
    getLastSyncTime(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        return metadata.sync_times?.[databaseId] || null;
    }

    /**
     * Update sync time for a database
     */
    _updateSyncTime(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        if (!metadata.sync_times) metadata.sync_times = {};
        metadata.sync_times[databaseId] = new Date().toISOString();
        metadata.last_refresh = new Date().toISOString();
        this._writeJson(this.metadataPath, metadata);
    }

    /**
     * Update full-sync checkpoint time for a database
     * @param {string} databaseId
     */
    _updateFullSyncTime(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        if (!metadata.full_sync_times) metadata.full_sync_times = {};
        metadata.full_sync_times[databaseId] = new Date().toISOString();
        this._writeJson(this.metadataPath, metadata);
    }

    /**
     * Get last full-sync checkpoint time for a database
     * @param {string} databaseId
     * @returns {string|null}
     */
    getLastFullSyncTime(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        return metadata.full_sync_times?.[databaseId] || null;
    }

    /**
     * Check whether a database is due for full-sync checkpoint
     * @param {string} databaseId
     * @param {number} checkpointMs
     * @returns {boolean}
     */
    isFullSyncDue(databaseId, checkpointMs = 6 * 60 * 60 * 1000) {
        const lastFullSync = this.getLastFullSyncTime(databaseId);
        if (!lastFullSync) return true;
        const ts = new Date(lastFullSync).getTime();
        if (Number.isNaN(ts)) return true;
        return (Date.now() - ts) >= checkpointMs;
    }

    /**
     * Persist latest sync audit per database for quick diagnostics
     * @param {string} databaseId
     * @param {Object} audit
     */
    _recordSyncAudit(databaseId, audit) {
        const metadata = this._readJson(this.metadataPath, {});
        if (!metadata.sync_audit) metadata.sync_audit = {};
        metadata.sync_audit[databaseId] = {
            ...audit,
            updated_at: new Date().toISOString()
        };
        this._writeJson(this.metadataPath, metadata);
    }

    /**
     * Set Notion count for a database (persists across reloads)
     * @param {string} databaseId 
     * @param {number} count 
     */
    setNotionCount(databaseId, count) {
        try {
            const metadata = this._readJson(this.metadataPath, {});
            if (!metadata.notion_counts) metadata.notion_counts = {};

            // Normalize ID to ensure consistency
            // const normalizedId = databaseId.toLowerCase(); 
            // Keeping raw ID for now but valid point to check later

            metadata.notion_counts[databaseId] = count;
            this._writeJson(this.metadataPath, metadata);
            console.log(`[Database] 💾 Saved Notion count for ${databaseId.substring(0, 8)}: ${count}`);
        } catch (e) {
            console.error(`[Database] ❌ Failed to save Notion count: ${e.message}`);
        }
    }

    /**
     * Set Database Name (persists across reloads)
     * @param {string} databaseId 
     * @param {string} name 
     */
    setDatabaseName(databaseId, name) {
        const metadata = this._readJson(this.metadataPath, {});
        if (!metadata.database_names) metadata.database_names = {};
        metadata.database_names[databaseId] = name;
        this._writeJson(this.metadataPath, metadata);
    }

    /**
     * Get stored Database Name
     * @param {string} databaseId 
     * @returns {string|null}
     */
    getDatabaseName(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        return metadata.database_names?.[databaseId] || null;
    }

    /**
     * Get stored Notion count for a database
     * @param {string} databaseId 
     * @returns {number|null}
     */
    getNotionCount(databaseId) {
        const metadata = this._readJson(this.metadataPath, {});
        const count = metadata.notion_counts?.[databaseId];
        // console.log(`[Database] 📖 Read Notion count for ${databaseId.substring(0, 8)}: ${count}`);
        return count !== undefined ? count : null;
    }

    /**
     * Get last update timestamp
     * @returns {string}
     */
    getLastUpdate() {
        return this.getMetadata('last_refresh');
    }

    // ==================== DATA METHODS ====================

    /**
     * Save data from a database (overwrite)
     * @param {string} databaseId
     * @param {Array} records
     */
    saveData(databaseId, records) {
        const cacheFile = this._getCacheFilePath(databaseId);
        const existingData = this._readJson(cacheFile, []);
        this._writeJson(cacheFile, records);
        this._updateSyncTime(databaseId);
        this._updateFullSyncTime(databaseId);

        // Update lookup cache incrementally
        this.updateLookupCacheIncremental(records);

        const deletedCount = Math.max(0, existingData.length - records.length);
        this._recordSyncAudit(databaseId, {
            mode: 'full_sync',
            total: records.length,
            new: records.length,
            updated: 0,
            deleted: deletedCount
        });

        console.log(`[Database] ✅ Saved ${records.length} records for ${databaseId.substring(0, 8)}...`);
        debugLog(`Saved ${records.length} records for ${databaseId}`);
    }

    /**
     * Upsert data (merge new records with existing)
     * @param {string} databaseId 
     * @param {Array} newRecords 
     */
    upsertData(databaseId, newRecords) {
        if (!newRecords || newRecords.length === 0) {
            debugLog(`Upsert skipped for ${databaseId}: No new records`);

            // Still need to return total count for UI
            const cacheFile = this._getCacheFilePath(databaseId);
            const existingData = this._readJson(cacheFile, []);

            // IMPORTANT: Update sync time because we just confirmed data is up-to-date
            this._updateSyncTime(databaseId);

            return {
                total: existingData.length,
                new: 0,
                updated: 0,
                deleted: 0
            };
        }

        const cacheFile = this._getCacheFilePath(databaseId);
        const existingData = this._readJson(cacheFile, []);
        const existingMap = new Map(existingData.map(r => [r.id, r]));

        // Update or add new records
        let newCount = 0;
        let updateCount = 0;

        newRecords.forEach(record => {
            if (existingMap.has(record.id)) {
                updateCount++;
            } else {
                newCount++;
            }
            existingMap.set(record.id, record);
        });

        // Convert back to absolute array and save
        const mergedData = Array.from(existingMap.values());
        this._writeJson(cacheFile, mergedData);
        this._updateSyncTime(databaseId);

        // Update lookup cache incrementally
        this.updateLookupCacheIncremental(newRecords);
        this._recordSyncAudit(databaseId, {
            mode: 'incremental_upsert',
            total: mergedData.length,
            new: newCount,
            updated: updateCount,
            deleted: 0
        });

        const msg = `[Database] 🔄 Upserted for ${databaseId.substring(0, 8)}... (New: ${newCount}, Updated: ${updateCount}, Total: ${mergedData.length})`;
        console.log(msg);
        debugLog(msg);

        return {
            total: mergedData.length,
            new: newCount,
            updated: updateCount,
            deleted: 0
        };
    }

    /**
     * Get all cached data for a database
     * @param {string} databaseId
     * @returns {Array}
     */
    getData(databaseId) {
        const cacheFile = this._getCacheFilePath(databaseId);
        return this._readJson(cacheFile, []);
    }

    /**
     * Get all cached data (loads all database files)
     * @returns {Object} Object keyed by database ID
     */
    getAllData() {
        const allData = {};

        try {
            const files = readdirSync(this.cacheDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const dbId = file.replace('.json', '');
                    const filePath = join(this.cacheDir, file);
                    const data = this._readJson(filePath, []);
                    if (data.length > 0) {
                        allData[dbId] = data;
                    }
                }
            }
        } catch (error) {
            console.error('[Database] Error reading cache directory:', error.message);
        }

        return allData;
    }

    /**
     * Get data for selected databases only (optimized)
     * @returns {Object} Object keyed by database ID
     */
    getSelectedData() {
        const selectedDbs = this.getConfig('selected_databases') || [];
        const data = {};

        for (const dbId of selectedDbs) {
            data[dbId] = this.getData(dbId);
        }

        return data;
    }

    /**
     * Delete cache for a database
     * @param {string} databaseId
     */
    deleteData(databaseId) {
        const cacheFile = this._getCacheFilePath(databaseId);
        if (existsSync(cacheFile)) {
            unlinkSync(cacheFile);
            console.log(`[Database] 🗑️ Deleted cache for ${databaseId.substring(0, 8)}...`);
        }
    }

    /**
     * Clear all cache files
     */
    clearAllCache() {
        try {
            const files = readdirSync(this.cacheDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    unlinkSync(join(this.cacheDir, file));
                }
            }
            console.log('[Database] 🗑️ All cache cleared');
        } catch (error) {
            console.error('[Database] Error clearing cache:', error.message);
        }
    }

    // ==================== COMPATIBILITY METHODS ====================

    /**
     * Legacy compatibility: Read entire "database"
     * Returns combined structure for backward compatibility
     */
    readData() {
        return {
            config: this._readJson(this.configPath, {}),
            metadata: this._readJson(this.metadataPath, {}),
            data_cache: this.getAllData()
        };
    }

    /**
     * Legacy compatibility: Write entire "database"
     * Splits data back to individual files
     */
    writeData(data) {
        if (data.config) {
            this._writeJson(this.configPath, data.config);
        }
        if (data.metadata) {
            this._writeJson(this.metadataPath, data.metadata);
        }
        if (data.data_cache) {
            for (const [dbId, records] of Object.entries(data.data_cache)) {
                if (Array.isArray(records)) {
                    const cacheFile = this._getCacheFilePath(dbId);
                    this._writeJson(cacheFile, records);
                }
            }
        }
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get cache statistics
     */
    getStats() {
        const stats = {
            databases: 0,
            totalRecords: 0,
            cacheFiles: [],
            lastRefresh: this.getLastUpdate()
        };

        try {
            const files = readdirSync(this.cacheDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = join(this.cacheDir, file);
                    const data = this._readJson(filePath, []);
                    const fileStats = {
                        id: file.replace('.json', ''),
                        records: data.length,
                        file: file
                    };
                    stats.cacheFiles.push(fileStats);
                    stats.databases++;
                    stats.totalRecords += data.length;
                }
            }
        } catch (error) {
            console.error('[Database] Error getting stats:', error.message);
        }

        return stats;
    }

    /**
     * Export all data for backup/transfer
     * @returns {Object} Complete data export
     */
    exportAll() {
        return {
            exportTime: new Date().toISOString(),
            config: this._readJson(this.configPath, {}),
            metadata: this._readJson(this.metadataPath, {}),
            data_cache: this.getAllData()
        };
    }

    /**
     * Import data from backup
     * @param {Object} data - Data to import
     */
    importAll(data) {
        if (data.config) {
            this._writeJson(this.configPath, data.config);
        }
        if (data.metadata) {
            this._writeJson(this.metadataPath, data.metadata);
        }
        if (data.data_cache) {
            for (const [dbId, records] of Object.entries(data.data_cache)) {
                if (Array.isArray(records)) {
                    this.saveData(dbId, records);
                }
            }
        }
        console.log('[Database] ✅ Import completed');
    }

    /**
     * Close database connection (no-op for JSON files)
     */
    close() {
        console.log('[Database] Closed');
    }

    // ==================== LOOKUP CACHE METHODS ====================

    /**
     * Build lookup caches asynchronously (on startup)
     * @private
     */
    async _buildLookupCacheAsync() {
        // Use setImmediate to not block constructor
        setImmediate(() => {
            try {
                this.buildLookupCache();
            } catch (error) {
                console.error('[Database] Failed to build initial lookup cache:', error.message);
            }
        });
    }

    /**
     * Build in-memory lookup maps from all cached data
     * This is expensive but only done once (or after sync)
     */
    buildLookupCache() {
        const startTime = Date.now();
        console.log('[Database] 🔄 Building lookup cache...');

        const lookupMap = new Map();
        const userMap = new Map();

        try {
            const files = readdirSync(this.cacheDir);
            let totalRecords = 0;

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const filePath = join(this.cacheDir, file);
                const records = this._readJson(filePath, []);

                for (const record of records) {
                    totalRecords++;

                    // Build ID -> Title map
                    let name = record._title;
                    if (!name && record.properties) {
                        name = record.properties['Name'] ||
                            record.properties['Title'] ||
                            record.properties['Tên'];
                        if (!name) {
                            const lowerProps = Object.keys(record.properties).reduce((acc, key) => {
                                acc[key.toLowerCase()] = record.properties[key];
                                return acc;
                            }, {});
                            name = lowerProps['name'] || lowerProps['title'] ||
                                lowerProps['task name'] || lowerProps['sprint name'] ||
                                lowerProps['product name'] || lowerProps['project name'] ||
                                lowerProps['subject'] || lowerProps['item'] ||
                                lowerProps['content'] || lowerProps['summary'] || lowerProps['work'];
                        }
                    }

                    if (record.id) {
                        const id = record.id.toLowerCase();
                        if (name) {
                            if (typeof name !== 'string') name = String(name);
                            lookupMap.set(id, name);
                        } else {
                            lookupMap.set(id, `[Untitled: ${record.id}]`);
                        }
                    }

                    // Build Email -> Name map
                    if (record.properties) {
                        Object.values(record.properties).forEach(val => {
                            if (Array.isArray(val)) {
                                val.forEach(item => {
                                    if (item && typeof item === 'object') {
                                        if (item.email && item.name &&
                                            item.name !== item.email && item.name !== 'Unknown User') {
                                            userMap.set(item.email.toLowerCase().trim(), item.name);
                                        }
                                        if (item.object === 'user' && item.name) {
                                            userMap.set(item.name.toLowerCase(), item.name);
                                        }
                                    }
                                });
                            } else if (val && typeof val === 'object' && val.email && val.name) {
                                if (val.name !== val.email && val.name !== 'Unknown User') {
                                    userMap.set(val.email.toLowerCase().trim(), val.name);
                                }
                            }
                        });
                    }
                }
            }

            this._lookupMapCache = lookupMap;
            this._userMapCache = userMap;
            this._lookupCacheBuiltAt = Date.now();

            const elapsed = Date.now() - startTime;
            console.log(`[Database] ✅ Lookup cache built: ${lookupMap.size} IDs, ${userMap.size} users from ${totalRecords} records (${elapsed}ms)`);
        } catch (error) {
            console.error('[Database] Error building lookup cache:', error.message);
            debugLog(`Error building lookup cache: ${error.message}`);
        }
    }

    /**
     * Get cached lookup maps (ID -> Title)
     * Rebuilds if cache is empty or stale
     * @returns {{ lookupMap: Map, userMap: Map }}
     */
    getLookupMaps() {
        // Rebuild if cache is empty
        if (!this._lookupMapCache || !this._userMapCache) {
            this.buildLookupCache();
        }

        return {
            lookupMap: this._lookupMapCache || new Map(),
            userMap: this._userMapCache || new Map()
        };
    }

    /**
     * Invalidate lookup cache (call after data sync)
     */
    invalidateLookupCache() {
        this._lookupMapCache = null;
        this._userMapCache = null;
        this._lookupCacheBuiltAt = null;
        console.log('[Database] 🔄 Lookup cache invalidated');
    }

    /**
     * Update lookup cache incrementally with new records
     * More efficient than full rebuild for small updates
     * @param {Array} records - New/updated records
     */
    updateLookupCacheIncremental(records) {
        if (!this._lookupMapCache) {
            this.buildLookupCache();
            return;
        }

        let added = 0;
        for (const record of records) {
            let name = record._title;
            if (!name && record.properties) {
                name = record.properties['Name'] || record.properties['Title'] || record.properties['Tên'];
            }

            if (record.id && name) {
                const id = record.id.toLowerCase();
                if (typeof name !== 'string') name = String(name);
                this._lookupMapCache.set(id, name);
                added++;
            }

            // Update user map
            if (record.properties) {
                Object.values(record.properties).forEach(val => {
                    if (Array.isArray(val)) {
                        val.forEach(item => {
                            if (item && typeof item === 'object' && item.email && item.name &&
                                item.name !== item.email && item.name !== 'Unknown User') {
                                this._userMapCache.set(item.email.toLowerCase().trim(), item.name);
                            }
                        });
                    }
                });
            }
        }

        if (added > 0) {
            debugLog(`Lookup cache updated incrementally: +${added} entries`);
        }
    }
}

// Singleton instance for shared usage
let _singleton = null;

export function getDbInstance() {
    if (!_singleton) {
        _singleton = new DatabaseManager();
    }
    return _singleton;
}
