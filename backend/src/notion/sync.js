import { Client } from '@notionhq/client';

/**
 * SyncService - Compares Notion data with Local cache
 */
export class SyncService {
    constructor(notion, db) {
        this.notion = notion;
        this.db = db;
    }

    /**
     * Get sync overview for all databases
     */
    async getOverview(databaseIds = null) {
        const overview = [];

        try {
            // Get stats for all databases
            const allStats = this.db.getStats();
            const allCachedIds = allStats.cacheFiles.map(file => file.id);
            const targetIds = Array.isArray(databaseIds) && databaseIds.length > 0
                ? [...new Set(databaseIds.filter(id => typeof id === 'string' && id.trim().length > 0))]
                : allCachedIds;

            // Loop through target databases (selected + priority by caller, fallback all cached)
            for (const dbId of targetIds) {
                const data = this.db.getData(dbId);
                const lastSync = this.db.getLastSyncTime(dbId);

                // Keep overview lightweight and reliable: use cached names only.
                // Notion calls for every row can make Sync Monitor appear broken/slow.
                let dbName = this.db.getDatabaseName(dbId) || 'Database ' + dbId.substring(0, 8);

                const nc = this.db.getNotionCount(dbId);

                overview.push({
                    id: dbId,
                    name: dbName,
                    local_count: data?.length || 0,
                    notion_count: nc,
                    last_sync: lastSync || null
                });
            }
        } catch (error) {
            console.error('[SyncService] Error in getOverview:', error.message);
        }

        return overview;
    }

    /**
     * Check sync status for a specific database
     * Compares Notion vs Local data
     */
    async checkDatabase(databaseId) {
        // Get local data
        const localData = this.db.getData(databaseId) || [];
        const local_count = localData.length;

        // Fetch Notion data (IDs only for speed)
        let notionPages = [];
        try {
            let hasMore = true;
            let cursor = undefined;

            while (hasMore) {
                const response = await this.notion.databases.query({
                    database_id: databaseId,
                    start_cursor: cursor,
                    page_size: 100
                });

                notionPages.push(...response.results);
                hasMore = response.has_more;
                cursor = response.next_cursor;
            }
        } catch (error) {
            console.error(`[SyncService] Error fetching Notion data for ${databaseId}:`, error.message);
            throw new Error(`Failed to fetch Notion data: ${error.message}`);
        }

        const notion_count = notionPages.length;

        // Build ID maps
        const localIds = new Set(localData.map(p => p.id));
        const notionIds = new Set(notionPages.map(p => p.id));
        const notionMap = new Map(notionPages.map(p => [p.id, p]));

        // Find mismatches
        const mismatches = [];

        // Missing in Notion (deleted)
        for (const localPage of localData) {
            if (!notionIds.has(localPage.id)) {
                mismatches.push({
                    id: localPage.id,
                    type: 'missing_in_notion',
                    local_updated: localPage.last_edited_time,
                    notion_updated: null
                });
            }
        }

        // Missing in Local (new in Notion)
        for (const notionPage of notionPages) {
            if (!localIds.has(notionPage.id)) {
                mismatches.push({
                    id: notionPage.id,
                    type: 'missing_in_local',
                    local_updated: null,
                    notion_updated: notionPage.last_edited_time,
                    url: notionPage.url
                });
            }
        }

        // Outdated (different last_edited_time)
        for (const localPage of localData) {
            if (notionIds.has(localPage.id)) {
                const notionPage = notionMap.get(localPage.id);
                if (localPage.last_edited_time !== notionPage.last_edited_time) {
                    mismatches.push({
                        id: localPage.id,
                        type: 'outdated',
                        local_updated: localPage.last_edited_time,
                        notion_updated: notionPage.last_edited_time,
                        url: notionPage.url
                    });
                }
            }
        }

        return {
            local_count,
            notion_count,
            diff_count: mismatches.length,
            mismatches
        };
    }
}
