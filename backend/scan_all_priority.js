import { Client } from '@notionhq/client';
import fs from 'fs';

const token = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN;
if (!token) {
    throw new Error('Missing NOTION_ACCESS_TOKEN or NOTION_TOKEN');
}
const client = new Client({ auth: token });

const projects = [
    { name: 'SUN', id: '28eccb0e-ac88-80fa-b380-d4c747d0671e' },
    { name: 'MAM', id: '27eccb0e-ac88-8079-9999-c0fb148af9a4' },
    { name: 'IMM', id: '27eccb0e-ac88-808c-9479-f2555968255a' },
    { name: 'GEN', id: '28fccb0e-ac88-809d-9d36-e2584a27034a' },
    { name: 'MIR', id: '2d3ccb0e-ac88-80de-9286-fbb50dde8a6d' },
    { name: 'XANH', id: '2c5ccb0e-ac88-809b-b452-f82ee00b16c2' },
    // { name: 'GUI', id: '2c3ccb0e-ac88-801a-bc84-dbf6a1d4acc3' }, // GUI already done
    { name: 'LEG', id: '2efccb0e-ac88-80a2-a55d-d1a58480c246' },
    { name: 'HAR', id: '2d8ccb0e-ac88-80b0-8a33-fbb881e41e9b' },
    { name: 'FCM', id: '2edccb0e-ac88-805c-824b-f31a17cadb68' }
];

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
        // console.error(`Error:`, e.message);
    }
    return dbs;
}

(async () => {
    const results = {};
    for (const p of projects) {
        console.log(`Scanning ${p.name}...`);
        results[p.id] = await scanPage(p.id);
        console.log(`  Found ${results[p.id].length} DBs`);
    }

    fs.writeFileSync('scan_results.json', JSON.stringify(results, null, 2));
    console.log('Done!');
})();
