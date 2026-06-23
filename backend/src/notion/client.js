import { Client } from '@notionhq/client';

/**
 * Notion API Client with pagination support
 */
export class NotionClient {
    constructor(accessToken) {
        this.notion = new Client({ auth: accessToken });
        this.requestDelay = 350; // 3 requests/second rate limit
    }

    /**
     * Delay helper for rate limiting
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch all pages from a database with proper pagination
     * @param {string} databaseId - The database ID
     * @param {Object} filter - Optional filter object
     * @returns {Promise<Array>} All pages from the database
     */
    async getAllPages(databaseId, filter = undefined) {
        let allPages = [];
        let hasMore = true;
        let startCursor = undefined;
        let pageCount = 0;
        const maxRetries = 3;

        console.log(`[Notion] Fetching pages from database: ${databaseId}`);

        while (hasMore) {
            let retries = 0;
            let success = false;

            while (!success && retries < maxRetries) {
                try {
                    const response = await this.notion.databases.query({
                        database_id: databaseId,
                        start_cursor: startCursor,
                        filter: filter,
                        page_size: 100
                    });

                    allPages = allPages.concat(response.results);
                    hasMore = response.has_more;
                    startCursor = response.next_cursor;
                    pageCount++;
                    success = true;

                    console.log(`[Notion] Fetched page ${pageCount}, got ${response.results.length} items (Total: ${allPages.length})`);

                    // Rate limiting
                    if (hasMore) {
                        await this.delay(this.requestDelay);
                    }
                } catch (error) {
                    retries++;
                    const isNetworkError = error.message?.includes('ECONNRESET') ||
                        error.message?.includes('ETIMEDOUT') ||
                        error.message?.includes('ENOTFOUND') ||
                        error.code === 'ECONNRESET' ||
                        error.code === 'rate_limited';

                    if (isNetworkError && retries < maxRetries) {
                        const backoff = Math.pow(2, retries) * 1000; // 2s, 4s, 8s
                        console.warn(`[Notion] ⚠️ Retry ${retries}/${maxRetries} for page ${pageCount + 1} after ${backoff}ms...`);
                        await this.delay(backoff);
                    } else {
                        console.error(`[Notion] Error fetching pages (attempt ${retries}):`, error.message);
                        throw error;
                    }
                }
            }
        }

        console.log(`[Notion] ✅ Completed: ${allPages.length} total items from database`);
        return allPages;
    }

    /**
     * Search for all databases accessible to the integration
     * @returns {Promise<Array>} List of databases
     */
    async searchDatabases() {
        let allDatabases = [];
        let hasMore = true;
        let startCursor = undefined;

        console.log('[Notion] Searching for databases...');

        while (hasMore) {
            try {
                const response = await this.notion.search({
                    filter: { property: 'object', value: 'database' },
                    start_cursor: startCursor,
                    page_size: 100
                });

                allDatabases = allDatabases.concat(response.results);
                hasMore = response.has_more;
                startCursor = response.next_cursor;

                if (hasMore) {
                    await this.delay(this.requestDelay);
                }
            } catch (error) {
                console.error('[Notion] Error searching databases:', error);
                throw error;
            }
        }

        console.log(`[Notion] ✅ Found ${allDatabases.length} databases`);
        return allDatabases;
    }

    /**
     * Get database schema/properties
     * @param {string} databaseId
     * @returns {Promise<Object>}
     */
    async getDatabaseSchema(databaseId) {
        try {
            const database = await this.notion.databases.retrieve({
                database_id: databaseId
            });
            return database.properties;
        } catch (error) {
            console.error(`[Notion] Error getting database schema:`, error);
            throw error;
        }
    }
}
