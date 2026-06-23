/**
 * Focused diagnostic: check specific databases (GUI, FCM, LEG) records structure
 * and see where tasks are lost
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');

function removeAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Check specific databases
const dbs = [
    { id: '2c3ccb0e-ac88-8175-995b-f4fd1d065d51', name: 'GUI Tasks' },
    { id: '2edccb0e-ac88-815c-a6de-c98c5d033c02', name: 'FCM Tasks' },
    { id: '2efccb0e-ac88-80a3-9975-e92b915a7a55', name: 'LEG Tasks' },
    { id: '2d8ccb0e-ac88-8182-bd6c-c197ae37266c', name: 'HAR Tasks' },
];

for (const dbInfo of dbs) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    if (!fs.existsSync(cacheFile)) { console.log(`\n⚠ MISSING: ${dbInfo.name}`); continue; }

    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    console.log(`\n=== ${dbInfo.name} (${dbInfo.id}) ===`);
    console.log(`File size: ${fs.statSync(cacheFile).size} bytes`);
    console.log(`Data type: ${typeof data}, isArray: ${Array.isArray(data)}`);

    if (!Array.isArray(data)) {
        console.log(`Data content (first 200 chars): ${JSON.stringify(data).slice(0, 200)}`);
        continue;
    }

    console.log(`Records: ${data.length}`);

    if (data.length === 0) continue;

    // Check first record structure
    const first = data[0];
    console.log(`First record keys: ${Object.keys(first).join(', ')}`);
    console.log(`database_name: "${first.database_name}"`);

    const props = first.properties || {};
    const propKeys = Object.keys(props);
    console.log(`Property keys (${propKeys.length}): ${propKeys.join(', ')}`);

    // Check if "Task" is in database_name
    const dbName = String(first.database_name || '').toLowerCase();
    console.log(`"task" in name: ${dbName.includes('task')}`);

    // Check for Ngày làm
    const nk = (key) => removeAccents(String(key || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
    const ngayLamCol = propKeys.find(k => nk(k) === 'ngay lam');
    console.log(`Ngày làm column: ${ngayLamCol || 'NOT FOUND'}`);

    // Check for Assignee
    const assigneeKeys = ['Assignee', 'Owner', 'assignee', 'owner', 'Người thực hiện'];
    const assigneeCol = propKeys.find(k => assigneeKeys.some(ak => k.toLowerCase() === ak.toLowerCase()));
    console.log(`Assignee column: ${assigneeCol || 'NOT FOUND'}`);

    // Show Ngay Lam values for first 3 records
    if (ngayLamCol) {
        console.log(`\nSample Ngày làm values:`);
        for (let i = 0; i < Math.min(5, data.length); i++) {
            const val = data[i].properties?.[ngayLamCol];
            console.log(`  [${i}] ${JSON.stringify(val).slice(0, 200)}`);
        }
    }

    // Count statuses
    const statusCounts = {};
    const dateStatusByPerson = {};
    const START = new Date('2026-01-01');
    const END = new Date('2026-01-31T23:59:59.999');

    let hasDate = 0, noDate = 0, inRange = 0, outRange = 0;

    for (const task of data) {
        // Get status
        const statusProp = task.properties?.['Task Status'] || task.properties?.['Status'];
        let status = '';
        if (statusProp) {
            if (statusProp.status) status = statusProp.status.name || '';
            else if (statusProp.select) status = statusProp.select.name || '';
            else if (typeof statusProp === 'string') status = statusProp;
            else if (Array.isArray(statusProp) && statusProp[0]) {
                if (statusProp[0].type === 'status') status = statusProp[0].status?.name || '';
                else if (statusProp[0].type === 'select') status = statusProp[0].select?.name || '';
            }
        }
        statusCounts[status || '(empty)'] = (statusCounts[status || '(empty)'] || 0) + 1;

        // Get date
        if (ngayLamCol) {
            const dateRaw = task.properties?.[ngayLamCol];
            let dateVal = null;
            if (dateRaw) {
                if (dateRaw.type === 'date' && dateRaw.date) dateVal = new Date(dateRaw.date.end || dateRaw.date.start);
                else if (dateRaw.type === 'formula' && dateRaw.formula) {
                    const f = dateRaw.formula;
                    const ds = f.string || f.date?.start || null;
                    if (ds) dateVal = new Date(ds);
                }
                else if (typeof dateRaw === 'string') dateVal = new Date(dateRaw);
                else if (dateRaw.start) dateVal = new Date(dateRaw.end || dateRaw.start);
            }

            if (dateVal && !isNaN(dateVal.getTime())) {
                hasDate++;
                if (dateVal >= START && dateVal <= END) inRange++;
                else outRange++;
            } else {
                noDate++;
            }
        } else {
            noDate++;
        }
    }

    console.log(`\nDate stats: hasDate=${hasDate}, noDate=${noDate}, inRange=${inRange}, outRange=${outRange}`);
    console.log(`Status counts: ${JSON.stringify(statusCounts)}`);

    // Show assignee names
    if (assigneeCol) {
        const names = new Set();
        for (const task of data) {
            const a = task.properties?.[assigneeCol];
            if (Array.isArray(a)) a.forEach(p => { if (p?.name) names.add(p.name); });
            else if (typeof a === 'string') names.add(a);
        }
        console.log(`Assignees (${names.size}): ${[...names].sort().join(', ')}`);
    }
}
