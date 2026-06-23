/**
 * Compare cache record counts vs what Notion API reports
 * for each Task database to see if cache is incomplete.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');
const PRIORITY_FILE = path.join(__dirname, 'data/priority_projects.json');
const META_FILE = path.join(__dirname, 'data/metadata.json');

const priority = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf-8'));
const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));

const taskDbIds = [];
for (const proj of priority.projects) {
    for (const db of proj.databases) {
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task'))
            taskDbIds.push({ id: db.id, name: db.name, code: proj.code });
    }
}

console.log('=== CACHE vs NOTION COMPARISON ===\n');
console.log('DB Code | DB Name | Cache Records | Last Sync | Full Sync Due?');
console.log('-'.repeat(90));

for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    let cacheCount = 0;
    if (fs.existsSync(cacheFile)) {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        cacheCount = Array.isArray(data) ? data.length : 0;
    }

    const syncTime = meta.sync_times?.[dbInfo.id] || 'NEVER';
    const lastFullSync = meta.last_full_sync?.[dbInfo.id] || meta.full_sync_times?.[dbInfo.id] || 'UNKNOWN';

    // Check file modification time
    let fileAge = 'N/A';
    if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
        fileAge = `${ageMin} min`;
    }

    console.log(`${dbInfo.code.padEnd(8)} | ${dbInfo.name.slice(0, 30).padEnd(30)} | ${String(cacheCount).padStart(6)} | ${String(syncTime).slice(0, 19)} | fileAge: ${fileAge}`);
}

// Now check the database metadata for full sync tracking
console.log('\n=== FULL SYNC CHECKPOINT INFO ===');
const dbMeta = meta.database_meta || meta.db_meta || {};
console.log('Keys in metadata:', Object.keys(meta).join(', '));

// Check if there's per-DB full sync time tracking
for (const key of Object.keys(meta)) {
    if (key.includes('full') || key.includes('sync') || key.includes('checkpoint')) {
        const val = meta[key];
        if (typeof val === 'object' && !Array.isArray(val)) {
            console.log(`\n${key}:`);
            for (const [k, v] of Object.entries(val).slice(0, 15)) {
                const dbCode = taskDbIds.find(d => d.id === k)?.code || k.slice(0, 8);
                console.log(`  ${dbCode}: ${JSON.stringify(v).slice(0, 100)}`);
            }
        } else {
            console.log(`${key}: ${JSON.stringify(val).slice(0, 200)}`);
        }
    }
}

// Check the db.json for full sync tracking
console.log('\n=== CHECKING DB MANAGER FOR FULL SYNC TIMES ===');
const dbJsonPath = path.join(__dirname, 'data/db.json');
if (fs.existsSync(dbJsonPath)) {
    const dbJson = JSON.parse(fs.readFileSync(dbJsonPath, 'utf-8'));
    console.log('db.json keys:', Object.keys(dbJson).join(', '));
    if (dbJson.full_sync_times) {
        for (const [k, v] of Object.entries(dbJson.full_sync_times)) {
            const dbCode = taskDbIds.find(d => d.id === k)?.code || k.slice(0, 8);
            console.log(`  ${dbCode}: ${v}`);
        }
    }
} else {
    console.log('No db.json found');
}

// Check the actual database manager
const dbManagerPath = path.join(__dirname, 'data');
const jsonFiles = fs.readdirSync(dbManagerPath).filter(f => f.endsWith('.json') && !f.startsWith('cache'));
console.log('\nData dir JSON files:', jsonFiles.join(', '));
