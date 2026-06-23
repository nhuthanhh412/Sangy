/**
 * Compare Notion API record count vs cache for each Task DB.
 * Uses token from config.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@notionhq/client';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');
const PRIORITY_FILE = path.join(__dirname, 'data/priority_projects.json');
const CONFIG_FILE = path.join(__dirname, 'data/config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
const notion = new Client({ auth: config.access_token });

const priority = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf-8'));
const taskDbIds = [];
for (const proj of priority.projects) {
    for (const db of proj.databases) {
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task'))
            taskDbIds.push({ id: db.id, name: db.name, code: proj.code });
    }
}

async function countNotionPages(dbId) {
    let total = 0;
    let hasMore = true;
    let cursor = undefined;
    while (hasMore) {
        const res = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor });
        total += res.results.length;
        hasMore = res.has_more;
        cursor = res.next_cursor;
        await new Promise(r => setTimeout(r, 200));
    }
    return total;
}

console.log('=== NOTION API vs CACHE ===\n');
console.log('Code   | Cache  | Notion | Diff   | Status');
console.log('-'.repeat(60));

let totalCacheDiff = 0;
for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    let cacheCount = 0;
    if (fs.existsSync(cacheFile)) {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        cacheCount = Array.isArray(data) ? data.length : 0;
    }

    try {
        const notionCount = await countNotionPages(dbInfo.id);
        const diff = notionCount - cacheCount;
        totalCacheDiff += Math.max(0, diff);
        const status = diff > 0 ? `❌ MISSING ${diff}` : (diff < 0 ? `⚠ EXTRA ${-diff}` : '✅ OK');
        console.log(`${dbInfo.code.padEnd(6)} | ${String(cacheCount).padStart(6)} | ${String(notionCount).padStart(6)} | ${String(diff).padStart(6)} | ${status}`);
    } catch (err) {
        console.log(`${dbInfo.code.padEnd(6)} | ${String(cacheCount).padStart(6)} | ERROR: ${err.message.slice(0, 40)}`);
    }
}

console.log(`\nTotal missing from cache: ${totalCacheDiff}`);
