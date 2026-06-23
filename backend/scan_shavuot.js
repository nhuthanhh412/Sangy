import { Client } from '@notionhq/client';
import fs from 'fs';

const token = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN;
if (!token) {
    throw new Error('Missing NOTION_ACCESS_TOKEN or NOTION_TOKEN');
}
const client = new Client({ auth: token });

// SHAVUOT project
const project = { name: 'OTH4', id: '2f6ccb0e-ac88-80be-b04e-e793a2241089' };

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

                    let type = 'other';
                    const n = title.toLowerCase();
                    if (n.includes('task')) type = 'tasks';
                    else if (n.includes('product')) type = 'products';
                    else if (n.includes('sprint')) type = 'sprints';
                    else if (n.includes('report') || n.includes('báo cáo')) type = 'reports';
                    else if (n.includes('issue')) type = 'issues';

                    dbs.push({ id: block.id, name: title, type: type });
                }
                else if (block.type === 'child_page' || block.has_children) {
                    const childDbs = await scanPage(block.id, depth + 1);
                    dbs = [...dbs, ...childDbs];
                }
            }
            hasMore = res.has_more;
            cursor = res.next_cursor;
        }
    } catch (e) {
        console.error(`Error:`, e.message);
    }
    return dbs;
}

(async () => {
    console.log(`Scanning SHAVUOT (${project.name})...`);
    const databases = await scanPage(project.id);
    console.log(`Found ${databases.length} databases:`);
    console.log(JSON.stringify(databases, null, 2));

    // Create the entry for priority_projects.json
    const entry = {
        name: "[DeeDee_2026_OTH4] SHAVUOT",
        id: project.id,
        code: "OTH4",
        databases: databases
    };

    console.log('\n--- Entry to add to priority_projects.json ---');
    console.log(JSON.stringify(entry, null, 2));

    console.log('\n--- Database IDs to add to priority_databases ---');
    console.log(JSON.stringify(databases.map(d => d.id), null, 2));
})();
