import { NotionClient } from './client.js';

/**
 * Database Discovery Service
 * Auto-discovers available Notion databases
 */
export class DatabaseDiscovery {
    constructor(accessToken) {
        this.client = new NotionClient(accessToken);
    }

    /**
     * Discover all accessible databases
     * @returns {Promise<Array>} List of databases with metadata
     */
    async discoverDatabases() {
        try {
            const databases = await this.client.searchDatabases();

            return databases.map(db => ({
                id: db.id,
                name: this.extractDatabaseName(db),
                url: db.url,
                created_time: db.created_time,
                last_edited_time: db.last_edited_time,
                properties: Object.keys(db.properties || {})
            }));
        } catch (error) {
            console.error('[Discovery] Error discovering databases:', error);
            throw error;
        }
    }

    /**
     * Extract database name from title property
     * @param {Object} database - Notion database object
     * @returns {string}
     */
    extractDatabaseName(database) {
        if (database.title && database.title.length > 0) {
            return database.title[0].plain_text || 'Untitled Database';
        }
        return 'Untitled Database';
    }

    /**
     * Get detailed info for specific database
     * @param {string} databaseId
     * @returns {Promise<Object>}
     */
    async getDatabaseInfo(databaseId) {
        try {
            const schema = await this.client.getDatabaseSchema(databaseId);

            return {
                id: databaseId,
                properties: Object.entries(schema).map(([name, prop]) => ({
                    name,
                    type: prop.type,
                    id: prop.id
                }))
            };
        } catch (error) {
            console.error(`[Discovery] Error getting database info:`, error);
            throw error;
        }
    }
}
