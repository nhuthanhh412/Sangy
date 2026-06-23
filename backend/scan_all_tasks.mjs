/**
 * scan_all_tasks.mjs
 * Quét tất cả Tasks databases của 13 dự án trong priority_projects.json
 * Lấy toàn bộ records từ đầu đến ngày 28/05/2026
 * Lưu vào frontend/public/data/tasks_snapshot.json
 * 
 * Chạy: node scan_all_tasks.mjs
 * Yêu cầu: NOTION_ACCESS_TOKEN hoặc NOTION_TOKEN trong môi trường
 */

import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN;
if (!TOKEN) {
    console.error('❌ Thiếu NOTION_ACCESS_TOKEN hoặc NOTION_TOKEN');
    process.exit(1);
}

const notion = new Client({ auth: TOKEN });
const END_DATE = '2026-05-28'; // Ngày kết thúc quét

// Đọc danh sách 13 dự án từ priority_projects.json
const PRIORITY_PATH = path.join(__dirname, 'data/priority_projects.json');
const priorityData = JSON.parse(fs.readFileSync(PRIORITY_PATH, 'utf-8'));

// Chỉ lấy các Tasks databases
const TASK_DBS = [];
for (const project of priorityData.projects) {
    for (const db of (project.databases || [])) {
        if (db.type === 'tasks') {
            TASK_DBS.push({
                id: db.id,
                name: db.name,
                project_name: project.name,
                project_code: project.code
            });
        }
    }
}

console.log(`📋 Tìm thấy ${TASK_DBS.length} Tasks databases từ ${priorityData.projects.length} dự án:`);
TASK_DBS.forEach(db => console.log(`  - [${db.project_code}] ${db.name} (${db.id})`));
console.log('');

// Delay helper
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Trích xuất giá trị property từ Notion page
function extractPropertyValue(prop) {
    if (!prop) return null;
    switch (prop.type) {
        case 'title':
            return prop.title?.map(t => t.plain_text).join('') || '';
        case 'rich_text':
            return prop.rich_text?.map(t => t.plain_text).join('') || '';
        case 'number':
            return prop.number ?? null;
        case 'select':
            return prop.select?.name || null;
        case 'multi_select':
            return (prop.multi_select || []).map(s => s.name).join(', ') || null;
        case 'status':
            return prop.status?.name || null;
        case 'date':
            return prop.date?.start || null;
        case 'checkbox':
            return prop.checkbox ?? false;
        case 'url':
            return prop.url || null;
        case 'email':
            return prop.email || null;
        case 'phone_number':
            return prop.phone_number || null;
        case 'formula':
            const fv = prop.formula;
            if (!fv) return null;
            if (fv.type === 'string') return fv.string;
            if (fv.type === 'number') return fv.number;
            if (fv.type === 'boolean') return fv.boolean;
            if (fv.type === 'date') return fv.date?.start || null;
            return null;
        case 'relation':
            return (prop.relation || []).map(r => r.id).join(', ') || null;
        case 'people':
            return (prop.people || []).map(p => p.name || p.id).join(', ') || null;
        case 'files':
            return (prop.files || []).map(f => f.name).join(', ') || null;
        case 'created_time':
            return prop.created_time || null;
        case 'last_edited_time':
            return prop.last_edited_time || null;
        case 'created_by':
            return prop.created_by?.name || null;
        case 'last_edited_by':
            return prop.last_edited_by?.name || null;
        case 'rollup':
            const rv = prop.rollup;
            if (!rv) return null;
            if (rv.type === 'number') return rv.number;
            if (rv.type === 'date') return rv.date?.start || null;
            if (rv.type === 'array') return (rv.array || []).map(a => extractPropertyValue(a)).filter(Boolean).join(', ');
            return null;
        default:
            return null;
    }
}

function transformPage(page, dbName, projectName, projectCode, dbId) {
    const props = {};
    for (const [key, val] of Object.entries(page.properties || {})) {
        props[key] = extractPropertyValue(val);
    }
    return {
        id: page.id,
        database_id: dbId,
        database_name: dbName,
        project_name: projectName,
        project_code: projectCode,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        properties: props
    };
}

// Fetch tất cả records từ một database (không filter theo date - lấy all để tính productivity)
async function fetchAllFromDatabase(db, retryCount = 0) {
    const records = [];
    let hasMore = true;
    let cursor = undefined;
    let page = 0;
    let consecutiveErrors = 0;

    console.log(`  ⏳ Đang quét: ${db.name}...`);

    while (hasMore) {
        try {
            const response = await notion.databases.query({
                database_id: db.id,
                start_cursor: cursor,
                page_size: 100,
                // Không filter - lấy tất cả records
            });

            for (const pageObj of response.results) {
                records.push(transformPage(pageObj, db.name, db.project_name, db.project_code, db.id));
            }

            hasMore = response.has_more;
            cursor = response.next_cursor;
            page++;
            consecutiveErrors = 0;

            if (hasMore) {
                // Remove artificial delay
            }
        } catch (error) {
            consecutiveErrors++;
            console.error(`    ⚠️ Error on page ${page}: ${error.message}`);
            const isRetriable = true; // Always retry on error
            
            if (isRetriable && consecutiveErrors <= 5) {
                const backoffMs = Math.pow(2, consecutiveErrors) * 1000;
                console.log(`    ⚠️ Retrying in ${backoffMs/1000}s...`);
                await delay(backoffMs);
                continue;
            }
            
            console.error(`    ❌ Failed on ${db.name}: ${error.message}`);
            break;
        }
    }

    console.log(`  ✅ ${db.name}: ${records.length} records`);
    return records;
}

// Main
(async () => {
    console.log(`🚀 Bắt đầu quét ${TASK_DBS.length} Tasks databases...`);
    console.log(`📅 Giới hạn đến ngày: ${END_DATE}\n`);

    const startTime = Date.now();
    const allRecords = [];
    const meta = {
        scanned_at: new Date().toISOString(),
        end_date: END_DATE,
        databases: [],
        total_records: 0
    };

    for (let i = 0; i < TASK_DBS.length; i++) {
        const db = TASK_DBS[i];
        console.log(`[${i+1}/${TASK_DBS.length}] ${db.project_code} - ${db.name}`);
        
        try {
            const records = await fetchAllFromDatabase(db);
            // Filter: chỉ lấy records có Ngay Lam <= END_DATE hoặc không có ngày (vẫn giữ để service filter)
            allRecords.push(...records);
            meta.databases.push({
                id: db.id,
                name: db.name,
                project_name: db.project_name,
                project_code: db.project_code,
                record_count: records.length
            });
        } catch (err) {
            console.error(`❌ Skipping ${db.name}: ${err.message}`);
            meta.databases.push({
                id: db.id,
                name: db.name,
                project_name: db.project_name,
                project_code: db.project_code,
                record_count: 0,
                error: err.message
            });
        }

        // Nghỉ 500ms giữa các database để tránh rate limit
        if (i < TASK_DBS.length - 1) {
            await delay(500);
        }
    }

    meta.total_records = allRecords.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Tạo output object
    const output = {
        _meta: meta,
        records: allRecords
    };

    // Đảm bảo thư mục output tồn tại
    const outputDir = path.join(__dirname, '../frontend/public/data');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'tasks_snapshot.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

    console.log('\n' + '='.repeat(60));
    console.log(`✅ HOÀN THÀNH! Thời gian: ${elapsed}s`);
    console.log(`📊 Tổng records: ${allRecords.length.toLocaleString()}`);
    console.log(`📁 Đã lưu vào: ${outputPath}`);
    console.log(`📦 Kích thước file: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
    console.log('');
    console.log('Chi tiết theo dự án:');
    meta.databases.forEach(db => {
        const status = db.error ? `❌ ${db.error}` : `✅ ${db.record_count} records`;
        console.log(`  [${db.project_code}] ${db.name}: ${status}`);
    });
    console.log('='.repeat(60));
    console.log('\n➡️  Tiếp theo: git add, commit, push để đẩy snapshot lên GitHub');

    // Auto push to git
    try {
        console.log('\n🚀 Auto pushing to git...');
        const { execSync } = await import('child_process');
        execSync('git add ../frontend/public/data/tasks_snapshot.json', { stdio: 'inherit' });
        execSync('git commit -m "chore: add full tasks snapshot for fast loading"', { stdio: 'inherit' });
        execSync('git push', { stdio: 'inherit' });
        console.log('✅ Đã push snapshot lên git thành công!');
    } catch (gitErr) {
        console.error('❌ Lỗi khi push lên git:', gitErr.message);
    }
})();
