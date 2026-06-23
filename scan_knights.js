import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'backend/data/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN || config.notion_token;
if (!token) {
    throw new Error('Missing NOTION_ACCESS_TOKEN or NOTION_TOKEN');
}

const client = new Client({ auth: token });

async function scanPage(pageId, depth = 0) {
    if (depth > 3) return [];

    let dbs = [];
    let hasMore = true;
    let cursor = undefined;

    try {
        while (hasMore) {
            const res = await client.blocks.children.list({
                block_id: pageId,
                start_cursor: cursor
            });

            for (const block of res.results) {
                if (block.type === 'child_database') {
                    const db = await client.databases.retrieve({ database_id: block.id });
                    const title = db.title.map(t => t.plain_text).join('');
                    console.log(`Found DB: [${title}] (${block.id})`);
                    dbs.push({ id: block.id, name: title, type: determineType(title) });
                } else if (block.type === 'child_page') {
                    const childDbs = await scanPage(block.id, depth + 1);
                    dbs = [...dbs, ...childDbs];
                } else if (block.has_children) {
                    const childDbs = await scanPage(block.id, depth + 1);
                    dbs = [...dbs, ...childDbs];
                }
            }
            hasMore = res.has_more;
            cursor = res.next_cursor;
        }
    } catch (e) {
        console.error(`Error scanning ${pageId}:`, e.message);
    }
    return dbs;
}

function determineType(name) {
    const n = name.toLowerCase();
    if (n.includes('task')) return 'tasks';
    if (n.includes('product')) return 'products';
    if (n.includes('sprint')) return 'sprints';
    if (n.includes('report') || n.includes('bao cao')) return 'reports';
    if (n.includes('issue')) return 'issues';
    return 'other';
}

(async () => {
    console.log('Scanning KNIGHTS project...');
    const projectId = '2c3ccb0e-ac88-801a-bc84-dbf6a1d4acc3';
    const dbs = await scanPage(projectId);
    console.log('--- FINAL JSON ---');
    console.log(JSON.stringify(dbs, null, 2));
})();
