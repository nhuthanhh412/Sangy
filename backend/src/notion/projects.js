import { Client } from '@notionhq/client';
import { getDbInstance } from '../database/db.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Helper to get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reuse singleton database manager
const db = getDbInstance();

/**
 * Projects Service
 * Fetches hierarchical project structure from [Chung]Dự án database
 */
export class ProjectsService {
    constructor(accessToken) {
        this.notion = new Client({ auth: accessToken });
        this.parentDbId = '32e4b218-7829-4f9d-b06d-bbe41ea33dae'; // [Chung]Dự án
        this.requestDelay = 350;

        // In-memory Cache
        this.cachedTree = null;
        this.lastCacheTime = 0;
        this.CACHE_TTL = 1000 * 60 * 60 * 2; // 2 hours (increased from 15 min)
        this.isRefreshing = false;
        this.refreshPromise = null; // To hold the promise of an ongoing refresh

        // Load cache from file on startup (instant load!)
        this.loadCacheFromFile();

        // Invalidate cache if priority_projects.json changed since last cache
        this._checkPriorityFileChanged();

        // Start background refresh if cache is stale
        if (!this.cachedTree || (Date.now() - this.lastCacheTime > this.CACHE_TTL)) {
            this.refreshCache().catch(console.error);
        } else {
            console.log('[Projects] Using fresh file cache, skipping Notion refresh');
        }
    }

    /**
     * Check if priority_projects.json has changed since last cache build.
     * If changed, invalidate the cache so it rebuilds with new DB IDs.
     */
    _checkPriorityFileChanged() {
        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            if (!fs.existsSync(priorityPath)) return;

            const content = fs.readFileSync(priorityPath, 'utf8');
            // Simple hash: use content length + first/last 200 chars as fingerprint
            const fingerprint = `${content.length}:${content.substring(0, 200)}:${content.substring(content.length - 200)}`;

            const savedFingerprint = db.getConfig('priority_file_fingerprint');
            if (savedFingerprint && savedFingerprint === fingerprint) {
                return; // No change
            }

            // File changed! Invalidate cache
            console.log('[Projects] ⚠️ priority_projects.json changed — invalidating project tree cache');
            this.cachedTree = null;
            this.lastCacheTime = 0;
            db.setConfig('projects_tree_cache_time', 0);
            db.setConfig('priority_file_fingerprint', fingerprint);
        } catch (e) {
            console.warn('[Projects] Could not check priority file changes:', e.message);
        }
    }




    /**
     * Load whitelist project IDs from priority_projects.json
     */
    loadWhitelistIds() {
        const ids = new Set();
        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            console.log('[Projects] Loading whitelist from:', priorityPath);
            if (fs.existsSync(priorityPath)) {
                const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
                if (data.projects) {
                    for (const proj of data.projects) {
                        ids.add(proj.id);
                    }
                    console.log('[Projects] Loaded', ids.size, 'whitelist IDs');
                }
            } else {
                console.warn('[Projects] Whitelist file not found at:', priorityPath);
            }
        } catch (e) {
            console.warn('[Projects] Could not load whitelist IDs:', e.message);
        }
        return ids;
    }

    /**
     * Load cached tree from file (for instant startup)
     */
    loadCacheFromFile() {
        try {
            const savedTree = db.getConfig('projects_tree_cache');
            const savedTime = db.getConfig('projects_tree_cache_time');

            if (savedTree && savedTime) {
                this.cachedTree = savedTree;
                this.lastCacheTime = savedTime;
                console.log(`[Projects] Loaded ${savedTree.length} projects from file cache (age: ${Math.round((Date.now() - savedTime) / 60000)} min)`);
            }
        } catch (e) {
            console.error('[Projects] Failed to load file cache:', e.message);
        }
    }

    /**
     * Save cache to file for persistence
     */
    saveCacheToFile() {
        try {
            db.setConfig('projects_tree_cache', this.cachedTree);
            db.setConfig('projects_tree_cache_time', this.lastCacheTime);
            console.log(`[Projects] Saved ${this.cachedTree?.length || 0} projects to file cache`);
        } catch (e) {
            console.error('[Projects] Failed to save file cache:', e.message);
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get all projects with their child databases (Cache-First)
     * @param {Object} options - Filter options
     * @returns {Promise<Array>} Array of projects with databases
     */
    async getProjectsTree(options = {}) {
        // If cache exists and is fresh enough, return it
        if (this.cachedTree && (Date.now() - this.lastCacheTime < this.CACHE_TTL)) {
            console.log('[Projects] Serving tree from cache');
            return this.filterTree(this.cachedTree, options);
        }

        // If cache is stale or doesn't exist, and a refresh is ongoing, wait for it
        if (this.isRefreshing && this.refreshPromise) {
            console.log('[Projects] Waiting for ongoing refresh...');
            await this.refreshPromise;
            // After waiting, the cache should be updated, so serve from it
            return this.filterTree(this.cachedTree, options);
        }

        // If no cache, or cache is stale and no refresh is ongoing, force refresh
        console.log('[Projects] Cache stale or empty, forcing refresh...');
        await this.refreshCache();
        return this.filterTree(this.cachedTree, options);
    }

    async refreshCache() {
        if (this.isRefreshing) return this.refreshPromise;

        this.isRefreshing = true;
        console.log('[Projects] Starting smart cache refresh (Priority First)...');

        this.refreshPromise = (async () => {
            try {
                // PHASE 1: Priority Scan
                const priorityTree = await this.buildTreePhase(true); // true = priority only
                this.cachedTree = priorityTree;
                this.lastCacheTime = Date.now();
                this.saveCacheToFile(); // Save to file for persistence
                console.log(`[Projects] Phase 1 Complete: ${priorityTree.length} priority projects cached.`);

                // PHASE 2: Everything else (Background)
                // Resolve now so UI gets data immediately, then scan remaining projects.

                this.buildTreePhase(false, priorityTree).then(fullTree => {
                    this.cachedTree = fullTree;
                    this.lastCacheTime = Date.now();
                    this.saveCacheToFile(); // Save full tree to file
                    console.log(`[Projects] ✅ Phase 2 Complete: ${fullTree.length} total projects cached.`);
                }).catch(e => console.error('[Projects] ❌ Phase 2 Scan Error:', e));

            } catch (e) {
                console.error('[Projects] Cache refresh failed:', e);
            } finally {
                this.isRefreshing = false;
                this.refreshPromise = null;
            }
        })();

        await this.refreshPromise;
    }

    async buildTreePhase(priorityOnly = false, existingTree = []) {
        console.log(`[Projects] Building tree phase (PriorityOnly: ${priorityOnly})...`);

        // 1. Get ALL visible databases (Fast, single request mostly)
        const allDatabases = await this.getAllVisibleDatabases();
        const dbMap = new Map(allDatabases.map(db => [db.id, db]));

        // 2. Get active projects
        const projects = await this.getAllProjects('all');

        // Filter Projects
        const PRIORITY_KEYWORDS = [
            'Disk Knight', 'SHAVUOT', 'NINJAGO', 'FC MOBILE',
            'HARRY', 'MIRACULOUS', 'XANHSM',
            'KNIGHTS', 'GENEVIEVE', 'Sunny Side', 'GUINEVERE', 'GUI',
            'Đại Hiệp', 'UPZI', 'LEGO', 'Victory',
            'Immortals', 'Mami', 'MAMI', 'GEN', 'HAR', 'LEG', 'SUN', 'IMM', 'FCM', 'MIR', 'XAV', 'Xanh Van',
            'Mật ngữ', 'LHMN', 'Lớp học Mật ngữ'
        ];


        // 3. Scan & Map
        const newResults = [];

        // Load Whitelist Config for Hardcoded DBs
        const whitelistConfig = new Map();
        const whitelistIds = new Set();
        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            if (fs.existsSync(priorityPath)) {
                const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
                data.projects?.forEach(p => {
                    if (p.id && p.databases) whitelistConfig.set(p.id, p.databases);
                    if (p.id) whitelistIds.add(p.id);
                });
            }
        } catch (e) { console.warn('[Projects] Failed to load whitelist config for mapping:', e.message); }

        const targetProjects = projects.filter(p => {
            const name = p.properties.Name?.title?.[0]?.plain_text || '';
            const isPriority = PRIORITY_KEYWORDS.some(k => name.toLowerCase().includes(k.toLowerCase()));

            if (priorityOnly) return isPriority || whitelistIds.has(p.id);

            const alreadyScanned = existingTree.some(ep => ep.id === p.id);
            return !alreadyScanned;
        });

        for (let idx = 0; idx < targetProjects.length; idx++) {
            const project = targetProjects[idx];
            const projectInfo = this.extractProjectInfo(project);
            let matchedDatabases = [];

            // Progress log for tracking on Render
            console.log(`[Projects] Progress: ${idx + 1}/${targetProjects.length} project scanned — "${projectInfo.name}"`);

            // STRATEGY 0: Hardcoded Whitelist (Fastest & Most Accurate)
            if (whitelistConfig.has(project.id)) {
                matchedDatabases = whitelistConfig.get(project.id);
                console.log(`[Projects] Using ${matchedDatabases.length} hardcoded DBs for ${projectInfo.name}`);
            } else {
                // HYBRID STRATEGY: Combine Speed (Smart Mapping) and Accuracy (Structure Scan)

                // 1. Try Smart Mapping first (Fast - no API calls)
                matchedDatabases = this.findMatchingDatabases(projectInfo, allDatabases);

                // 2. Perform Page Scan (Structure Scan) with timeout protection
                // Wrap in a timeout to prevent any single project from blocking Phase 2
                try {
                    const SCAN_TIMEOUT_MS = 15000; // 15 seconds max per project scan
                    const pageDbIds = await Promise.race([
                        this.scanPageForDatabases(project.id),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Scan timeout')), SCAN_TIMEOUT_MS))
                    ]);

                    if (pageDbIds.size > 0) {
                        const scannedDbs = Array.from(pageDbIds)
                            .map(id => {
                                const db = dbMap.get(id);
                                if (db) return { id: db.id, name: db.name, type: this.determineDatabaseType(db.name) };
                                return null;
                            })
                            .filter(Boolean);

                        // Merge scanned DBs, avoiding duplicates
                        const existingIds = new Set(matchedDatabases.map(d => d.id));
                        scannedDbs.forEach(d => {
                            if (!existingIds.has(d.id)) matchedDatabases.push(d);
                        });
                    }
                } catch (scanErr) {
                    console.warn(`[Projects] ⏱️ Scan skipped for "${projectInfo.name}": ${scanErr.message}`);
                }

                // Rate limiting for scan
                if (!priorityOnly) await this.delay(50);
            }

            newResults.push({
                ...projectInfo,
                databases: matchedDatabases,
                hasData: matchedDatabases.length > 0
            });
        }

        // Merge Phase 1 updates into existing tree?
        // If Priority Scan re-runs, updates...
        // Actually, merge logic needs to be map-based to avoid duplicates if project re-scanned.
        // But here we filtered targetProjects disjointly (if !priorityOnly).
        // If priorityOnly, existingTree is usually empty or irrelevant.

        const resultMap = new Map(existingTree.map(p => [p.id, p]));
        newResults.forEach(p => resultMap.set(p.id, p));

        const totalTree = Array.from(resultMap.values());

        // Sort
        totalTree.sort((a, b) => {
            const statusOrder = { 'In Progress': 1, 'Planning': 2, 'Backlog': 3, 'Paused': 4, 'Seedbed': 5, 'Done': 6 };
            const aOrder = statusOrder[a.status] || 99;
            const bOrder = statusOrder[b.status] || 99;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.name.localeCompare(b.name);
        });

        return totalTree;
    }

    // Remove old buildFullTree since it's replaced
    async buildFullTree_deprecated() { return []; }

    /**
     * Recursively find database IDs inside a page
     */
    async scanPageForDatabases(pageId, depth = 0) {
        if (depth > 2) return new Set(); // Limit depth to avoid infinite loops/timeouts

        const foundIds = new Set();

        try {
            let hasMore = true;
            let cursor = undefined;

            while (hasMore) {
                const response = await this.notion.blocks.children.list({
                    block_id: pageId,
                    start_cursor: cursor,
                    page_size: 100
                });

                for (const block of response.results) {
                    // 1. Inline Database
                    if (block.type === 'child_database') {
                        foundIds.add(block.id);
                    }
                    // 2. Linked Database
                    else if (block.type === 'link_to_page' && block.link_to_page.type === 'database_id') {
                        foundIds.add(block.link_to_page.database_id);
                    }
                    // 3. Containers (Toggle, Column, Synced Block) -> Recurse!
                    else if (block.has_children) {
                        // Only specific types usually contain DBs
                        if (['toggle', 'column_list', 'column', 'synced_block', 'child_page'].includes(block.type)) {
                            const childIds = await this.scanPageForDatabases(block.id, depth + 1);
                            childIds.forEach(id => foundIds.add(id));
                        }
                    }
                }

                hasMore = response.has_more;
                cursor = response.next_cursor;
                // Don't scan ALL pages of children if there are too many, just first 100 blocks usually enough
                if (depth > 0) hasMore = false;
            }
        } catch (e) {
            // Ignore permission errors for specific blocks
            // console.warn(`Failed to scan block ${pageId}:`, e.message);
        }

        return foundIds;
    }

    filterTree(tree, options) {
        const { statusFilter = null } = options;
        if (!statusFilter || statusFilter === 'all') {
            return tree; // Return the full tree if no filter or 'all'
        }

        // Load whitelist project IDs to always include them
        const whitelistIds = this.loadWhitelistIds();

        return tree.filter(p => {
            // Always include projects in whitelist, regardless of status
            if (whitelistIds.has(p.id)) {
                return true;
            }

            if (statusFilter === 'active') {
                return p.status !== 'Done';
            }
            return p.status === statusFilter;
        });
    }

    /**
     * Load whitelist project IDs from priority_projects.json
     */


    /**
     * Get ALL visible databases utilizing Search API
     */
    async getAllVisibleDatabases() {
        let allDatabases = [];
        let hasMore = true;
        let startCursor = undefined;

        try {
            while (hasMore) {
                try {
                    const response = await this.notion.search({
                        filter: {
                            value: 'database',
                            property: 'object'
                        },
                        start_cursor: startCursor,
                        page_size: 100
                    });

                    allDatabases = allDatabases.concat(response.results);
                    hasMore = response.has_more;
                    startCursor = response.next_cursor;
                    await this.delay(this.requestDelay);
                } catch (e) {
                    console.warn(`[Projects] Search pagination warning: ${e.message}`);
                    // Break loop on pagination error but return what we have
                    break;
                }
            }

            return allDatabases.map(db => ({
                id: db.id,
                name: db.title?.[0]?.plain_text || 'Untitled',
                parent: db.parent
            }));
        } catch (error) {
            console.error('[Projects] Error searching databases:', error.message);
            return [];
        }
    }

    extractProjectInfo(project) {
        let name = 'Untitled';
        let status = '';
        let brand = [];
        let year = '';
        let projectId = '';

        for (const [key, prop] of Object.entries(project.properties)) {
            if (prop.type === 'title') {
                name = prop.title?.map(t => t.plain_text).join('') || 'Untitled';
            }
            if (prop.type === 'status') {
                status = prop.status?.name || '';
            }
            if (key === 'Brand' && prop.type === 'multi_select') {
                brand = prop.multi_select?.map(s => s.name) || [];
            }
            if (key === 'Năm' && prop.type === 'select') {
                year = prop.select?.name || '';
            }
            if (key === 'ID' && prop.type === 'unique_id') {
                projectId = prop.unique_id?.prefix + '-' + prop.unique_id?.number;
            }
        }

        const keywords = [name];

        // Dictionary for Project Code -> Database Keyword alias
        const CODE_ALIASES = {
            'GEN': 'Gene',
            'HAR': 'Harry',
            'MAM': 'Mami',
            'LEG': 'Lego',
            'MIR': 'Chibi', // Mapped to Chibi per debug
            'CHIBI': 'Chibi',
            'IMM': 'Immortals',
            'SUN': 'Sunny',
            'DK': 'Knight', // Disk Knight -> Knight
            'OTH4': 'Shavuot', // Guessing
            'LHMN': 'LHMN' // Lớp học Mật ngữ
        };

        // 1. Bracket content [Code]
        const bracketMatch = name.match(/\[(.*?)\]/);
        if (bracketMatch) {
            keywords.push(bracketMatch[1]); // e.g. DeeDee_2026_LEG
            const parts = bracketMatch[1].split('_');
            if (parts.length > 1) {
                const code = parts[parts.length - 1]; // LEG
                keywords.push(code);

                // Add Alias
                if (CODE_ALIASES[code]) {
                    keywords.push(CODE_ALIASES[code]);
                }
            }
        }

        // 2. Name after brackets
        const nameAfterBracket = name.replace(/\[.*?\]\s*/, '').trim();
        const dbNameHint = nameAfterBracket
            // Project titles sometimes have suffixes like "TEST" but DB titles do not.
            .replace(/\btest\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (nameAfterBracket.length > 0) {
            keywords.push(nameAfterBracket);

            if (nameAfterBracket.includes(' ')) {
                // First word
                const words = nameAfterBracket.split(' ');
                words.forEach(w => {
                    // Add significant words (>3 chars)
                    if (w.length > 3) keywords.push(w);
                });

                // First two words combined
                if (words.length >= 2) {
                    keywords.push(`${words[0]} ${words[1]}`);
                }
            }
        }

        // 3. Specific Project Aliases (Manual Overrides)
        if (name.includes("GENEVIEVE")) keywords.push("Gene");
        if (name.includes("MIRACULOUS")) keywords.push("Chibi");
        if (name.includes("XANHSM")) keywords.push("XANHSM");
        if (name.toLowerCase().includes("lego")) keywords.push("Lego");

        return {
            id: project.id,
            name,
            status,
            brand,
            year,
            projectId,
            dbNameHint,
            keywords: [...new Set(keywords)].filter(k => k && k.length > 2)
        };
    }

    findMatchingDatabases(projectInfo, allDatabases) {
        const exactPhraseMatches = [];
        const matched = [];
        const dbNameHintLower = projectInfo.dbNameHint?.toLowerCase() || '';

        for (const db of allDatabases) {
            const dbNameLower = db.name.toLowerCase();

            // Skip parent database itself
            if (db.id === this.parentDbId) continue;

            if (
                dbNameHintLower &&
                (
                    dbNameLower.includes(`[${dbNameHintLower}]`) ||
                    dbNameLower.startsWith(`${dbNameHintLower} `) ||
                    dbNameLower.includes(` ${dbNameHintLower} `)
                )
            ) {
                exactPhraseMatches.push({
                    id: db.id,
                    name: db.name,
                    type: this.determineDatabaseType(db.name)
                });
                continue;
            }

            let isMatch = false;

            // Checks keywords
            for (const keyword of projectInfo.keywords) {
                const keywordLower = keyword.toLowerCase();

                // Strict check: Database name must contain project keyword
                // Ideally in brackets like [Gene] or just Gene at start
                if (dbNameLower.includes(`[${keywordLower}]`) ||
                    dbNameLower.startsWith(`${keywordLower} `) ||
                    dbNameLower.includes(` ${keywordLower} `)) {

                    isMatch = true;
                    break;
                }
            }

            if (isMatch) {
                const dbType = this.determineDatabaseType(db.name);
                matched.push({
                    id: db.id,
                    name: db.name,
                    type: dbType
                });
            }
        }

        if (exactPhraseMatches.length > 0) {
            return exactPhraseMatches;
        }

        return matched;
    }

    /**
     * Get all projects from parent database
     */
    async getAllProjects(statusFilter = null) {
        let allProjects = [];
        let hasMore = true;
        let startCursor = undefined;

        const queryOptions = {
            database_id: this.parentDbId,
            page_size: 100
        };

        // Add status filter if provided
        if (statusFilter && statusFilter !== 'all') {
            if (statusFilter === 'active') {
                queryOptions.filter = {
                    property: 'Status',
                    status: {
                        does_not_equal: 'Done'
                    }
                };
            } else {
                queryOptions.filter = {
                    property: 'Status',
                    status: {
                        equals: statusFilter
                    }
                };
            }
        }

        while (hasMore) {
            queryOptions.start_cursor = startCursor;
            const response = await this.notion.databases.query(queryOptions);
            allProjects = allProjects.concat(response.results);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
            await this.delay(this.requestDelay);
        }

        return allProjects;
    }

    /**
     * Determine database type based on name
     */
    determineDatabaseType(name) {
        const nameLower = name.toLowerCase();
        if (nameLower.includes('task')) return 'tasks';
        if (nameLower.includes('product')) return 'products';
        if (nameLower.includes('sprint')) return 'sprints';
        if (nameLower.includes('doc')) return 'docs';
        if (nameLower.includes('changelog')) return 'changelog';
        if (nameLower.includes('issue')) return 'issues';
        if (nameLower.includes('báo cáo') || nameLower.includes('report')) return 'reports';
        return 'other';
    }

    /**
     * Fetch data for a specific database
     */
    async fetchDatabaseData(databaseId) {
        console.log(`[Projects] Fetching data for database ${databaseId}...`);

        try {
            let allPages = [];
            let hasMore = true;
            let startCursor = undefined;

            while (hasMore) {
                const response = await this.notion.databases.query({
                    database_id: databaseId,
                    start_cursor: startCursor,
                    page_size: 100
                });

                allPages = allPages.concat(response.results);
                hasMore = response.has_more;
                startCursor = response.next_cursor;

                if (hasMore) {
                    await this.delay(this.requestDelay);
                }
            }

            // Transform pages
            const transformed = allPages.map(page => this.transformPage(page, databaseId));

            console.log(`[Projects] Fetched ${transformed.length} records from database`);
            return transformed;

        } catch (error) {
            console.error(`[Projects] Error fetching database ${databaseId}:`, error.message);
            throw error;
        }
    }

    /**
     * Transform page to simplified format
     */
    transformPage(page, databaseId) {
        const transformed = {
            id: page.id,
            database_id: databaseId,
            created_time: page.created_time,
            last_edited_time: page.last_edited_time,
            properties: {}
        };

        for (const [key, prop] of Object.entries(page.properties)) {
            const value = this.extractPropertyValue(prop);
            transformed.properties[key] = value;

            if (prop.type === 'title') {
                transformed._title = value;
            }
        }

        return transformed;
    }

    /**
     * Extract value from Notion property
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
                    name: p.name || p.person?.email || 'Unknown'
                })) || [];
            case 'checkbox':
                return property.checkbox;
            case 'status':
                return property.status?.name || null;
            case 'relation':
                return property.relation?.map(r => r.id) || [];
            case 'formula':
                if (property.formula?.type === 'string') return property.formula.string;
                if (property.formula?.type === 'number') return property.formula.number;
                if (property.formula?.type === 'boolean') return property.formula.boolean;
                return null;
            case 'rollup':
                if (property.rollup?.type === 'number') return property.rollup.number;
                if (property.rollup?.type === 'array') return property.rollup.array;
                return null;
            default:
                return null;
        }
    }
}
