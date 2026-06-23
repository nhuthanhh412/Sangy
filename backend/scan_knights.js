import { Client } from '@notionhq/client';

const token = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN;
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

                    // Determine Type manually or by name
                    let type = 'other';
                    const n = title.toLowerCase();
                    if (n.includes('task')) type = 'tasks';
                    else if (n.includes('product')) type = 'products';
                    else if (n.includes('sprint')) type = 'sprints';
                    else if (n.includes('report') || n.includes('báo cáo')) type = 'reports';
                    else if (n.includes('issue')) type = 'issues';

                    dbs.push({ id: block.id, name: title, type: type });
                }
                // Recurse for child_page and containers
                else if (block.type === 'child_page' || block.has_children) {
                    // Filter only useful containers if block.has_children is generic, but child_page is key
                    // Just recurse all children containers for now
                    const childDbs = await scanPage(block.id, depth + 1);
                    dbs = [...dbs, ...childDbs];
                }
            }
            hasMore = res.has_more;
            cursor = res.next_cursor;
        }
    } catch (e) {
        // console.error(`Error scanning ${pageId}:`, e.message);
    }
    return dbs;
}

(async () => {
    console.log('Scanning KNIGHTS project...');
    const projectId = '2c3ccb0e-ac88-801a-bc84-dbf6a1d4acc3';
    const dbs = await scanPage(projectId);
    console.log('--- FINAL JSON ---');
    console.log(JSON.stringify(dbs, null, 2));
})();
