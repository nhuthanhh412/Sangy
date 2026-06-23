/**
 * Re-diagnostic after Notion data update.
 * Focus on the 18 remaining discrepancies.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');
const PRIORITY_FILE = path.join(__dirname, 'data/priority_projects.json');

import { SENIORITY_MAPPING, NAME_ALIAS_MAPPING } from './src/constants.js';

const priority = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf-8'));

const taskDbIds = [];
for (const proj of priority.projects) {
    for (const db of proj.databases) {
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task')) {
            taskDbIds.push({ id: db.id, name: db.name, project: proj.name, code: proj.code });
        }
    }
}

function removeAccents(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function normalizePersonName(name) {
    return removeAccents(String(name || '').toLowerCase().replace(/đ/g, 'd'))
        .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
const personAliasMap = new Map();
for (const [alias, canonical] of Object.entries(NAME_ALIAS_MAPPING)) {
    const norm = normalizePersonName(alias);
    if (norm && !personAliasMap.has(norm)) personAliasMap.set(norm, canonical);
}
for (const canonical of Object.keys(SENIORITY_MAPPING)) {
    const norm = normalizePersonName(canonical);
    if (norm && !personAliasMap.has(norm)) personAliasMap.set(norm, canonical);
}
function resolvePersonName(rawName) {
    const raw = String(rawName || '').trim();
    if (!raw) return '';
    const directAlias = NAME_ALIAS_MAPPING[raw];
    if (directAlias) return directAlias;
    const normalizedRaw = normalizePersonName(raw);
    const fixedMatch = personAliasMap.get(normalizedRaw);
    if (fixedMatch) return fixedMatch;
    const stripped = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped && stripped !== raw) {
        const strippedAlias = NAME_ALIAS_MAPPING[stripped];
        if (strippedAlias) return strippedAlias;
        const ns = normalizePersonName(stripped);
        const sm = personAliasMap.get(ns);
        if (sm) return sm;
    }
    for (const canonical of Object.keys(SENIORITY_MAPPING)) {
        const nc = normalizePersonName(canonical);
        if (nc && normalizedRaw.includes(nc)) return canonical;
    }
    return raw;
}

function getAssignees(task) {
    const props = task.properties || {};
    const keys = ['Assignee', 'Owner', 'assignee', 'owner', 'Người thực hiện', 'Người xử lý', 'Nhân sự', 'Person'];
    let assignees = null;
    for (const key of keys) { if (props[key]) { assignees = props[key]; break; } }
    if (!assignees) return [];
    if (Array.isArray(assignees)) return assignees.map(p => resolvePersonName(p?.name || '')).filter(Boolean);
    if (typeof assignees === 'string') { const r = resolvePersonName(assignees); return r ? [r] : []; }
    return [];
}

function getPropertyValue(task, ...propNames) {
    const props = task.properties;
    if (!props) return null;
    for (const propName of propNames) {
        let value = props[propName];
        if (value == null) {
            const lk = propName.toLowerCase();
            const mk = Object.keys(props).find(k => k.toLowerCase() === lk);
            if (mk) value = props[mk];
        }
        if (value != null) {
            if (value?.status) return value.status.name || null;
            if (value?.select) return value.select.name || null;
            if (Array.isArray(value)) {
                if (value.length === 0) return null;
                const f = value[0];
                if (f?.type === 'status') return f.status?.name || null;
                if (f?.type === 'select') return f.select?.name || null;
                if (f?.type === 'formula') return f.formula?.string ?? f.formula?.number ?? null;
                if (f?.plain_text !== undefined) return value.map(v => v.plain_text || '').join('');
            }
            if (typeof value === 'string') return value;
        }
    }
    return null;
}

function parseDate(task) {
    const props = task.properties;
    if (!props) return null;
    const nk = (key) => removeAccents(String(key || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
    const extractDate = (rawValue) => {
        let dv = rawValue;
        if (dv == null || dv === '') return null;
        if (Array.isArray(dv) && dv.length === 0) return null;
        if (typeof dv === 'object') {
            if (dv.type === 'formula') { const f = dv.formula || {}; dv = f.string || f.date || f.number || null; }
            else if (dv.type === 'rollup') { if (Array.isArray(dv.rollup?.array)) { const a = dv.rollup.array; const l = a[a.length - 1]; dv = l?.start || l?.formula?.string || l || null; } else dv = null; }
            else if (dv.type === 'date' && dv.date) { dv = dv.date; }
            else if (Array.isArray(dv.rich_text)) { dv = dv.rich_text[0]?.plain_text || null; }
            else if (Array.isArray(dv.title)) { dv = dv.title[0]?.plain_text || null; }
        }
        if (!dv) return null;
        if (typeof dv === 'object' && dv.start) { const ds = dv.end || dv.start; const p = new Date(ds); return isNaN(p.getTime()) ? null : p; }
        if (typeof dv === 'string') {
            dv = dv.trim();
            if (dv.includes('->')) dv = dv.split('->').pop().trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(dv)) return new Date(dv);
            const m = dv.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
            if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
            const f = new Date(dv); if (!isNaN(f.getTime())) return f;
        }
        return null;
    };
    const entries = Object.entries(props);
    const ngayLamEntry = entries.find(([key]) => nk(key) === 'ngay lam');
    if (ngayLamEntry) return extractDate(ngayLamEntry[1]);
    return null;
}

const START = new Date('2026-01-01');
const END = new Date('2026-01-31T23:59:59.999');

// Updated expected counts from new screenshot
const expectedCounts = {
    'Trịnh Tường Lê': 478, 'Trương Phú Miên Quỳnh': 64, 'Nguyễn Bích Ngọc': 57,
    'Hoàng Việt Linh': 63, 'Lê Hoàng Quốc Anh': 65, 'Hoàng Nguyễn Minh Thi': 189,
    'Nguyễn Khoa Diệu Hằng': 75, 'Nguyễn Xuân Yến': 54, 'Lường Thanh Bình': 35,
    'Đoàn Trung Kiên': 20, 'Nguyễn Thị Mỹ Khanh': 30, 'Nguyễn Thị Hòa': 150,
    'Đỗ Thành Trung': 285, 'Hoàng Ngọc Mỹ An': 30, 'Lê Nhật Minh': 19,
    'Nguyễn Thùy Linh': 25, 'Nguyễn Gia Lộc': 30, 'Nguyễn Nhật Hưng': 45,
    'Đỗ Quốc Huy': 162, 'Trần Thị Thanh Vân': 317, 'Đoàn Anh Kiệt': 448,
    'Nguyễn Thị Hoàng My': 98, 'Trần Thị Hồng Nhung': 106,
    'Ngô Nguyễn Đình Tuấn Minh': 70, 'Đinh Trí Bảo Anh': 104,
    'Nguyễn Thị Thanh': 31, 'Bùi Thị Giang': 44,
    'Hà Huy Hoàng': 89, 'Nguyễn Trường Phúc': 59, 'Hà Thị Mai': 64,
    'Cao Minh Khôi': 63, 'Vũ Hoàng An': 53,
};

// Report numbers from new screenshot
const reportCounts = {
    'Trịnh Tường Lê': 478, 'Trương Phú Miên Quỳnh': 64, 'Nguyễn Bích Ngọc': 54,
    'Hoàng Việt Linh': 63, 'Lê Hoàng Quốc Anh': 63, 'Hoàng Nguyễn Minh Thi': 189,
    'Nguyễn Khoa Diệu Hằng': 75, 'Nguyễn Xuân Yến': 53, 'Lường Thanh Bình': 34,
    'Đoàn Trung Kiên': 20, 'Nguyễn Thị Mỹ Khanh': 30, 'Nguyễn Thị Hòa': 148,
    'Đỗ Thành Trung': 268, 'Hoàng Ngọc Mỹ An': 30, 'Lê Nhật Minh': 19,
    'Nguyễn Thùy Linh': 25, 'Nguyễn Gia Lộc': 31, 'Nguyễn Nhật Hưng': 45,
    'Đỗ Quốc Huy': 163, 'Trần Thị Thanh Vân': 318, 'Đoàn Anh Kiệt': 42,
    'Nguyễn Thị Hoàng My': 60, 'Trần Thị Hồng Nhung': 100,
    'Ngô Nguyễn Đình Tuấn Minh': 72, 'Đinh Trí Bảo Anh': 91,
    'Nguyễn Thị Thanh': 31, 'Bùi Thị Giang': 45,
    'Hà Huy Hoàng': 85, 'Nguyễn Trường Phúc': 58, 'Hà Thị Mai': 67,
    'Cao Minh Khôi': 63, 'Vũ Hoàng An': 53,
};

// === Collect from cache ===
const personTasks = {};  // person -> { project: [{status, date, taskName}...] }
const unresolvedNames = new Set();

for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    if (!fs.existsSync(cacheFile)) continue;
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) continue;
    const dbName = String(data[0]?.database_name || '').toLowerCase();
    if (!dbName.includes('task')) continue;

    for (const task of data) {
        const doneDate = parseDate(task);
        if (!doneDate) continue;
        if (doneDate < START || doneDate > END) continue;

        const assignees = getAssignees(task);
        if (assignees.length === 0) continue;

        const status = getPropertyValue(task, 'Task Status') || getPropertyValue(task, 'Status') || '';
        const taskName = task._title || '';

        for (const person of assignees) {
            if (!personTasks[person]) personTasks[person] = {};
            if (!personTasks[person][dbInfo.code]) personTasks[person][dbInfo.code] = [];
            personTasks[person][dbInfo.code].push({ status, date: doneDate.toISOString().slice(0, 10), taskName: taskName.slice(0, 50) });
            if (!SENIORITY_MAPPING[person]) unresolvedNames.add(person);
        }
    }
}

// === Print comparison ===
console.log('=== DISCREPANCY ANALYSIS (Updated Data) ===\n');

const allPersons = [...new Set([...Object.keys(expectedCounts), ...Object.keys(personTasks)])].sort();
let discCount = 0;

for (const person of allPersons) {
    const exp = expectedCounts[person];
    const rep = reportCounts[person];
    if (exp == null) continue;

    const tasks = personTasks[person] || {};
    let myTotal = 0;
    const projBreakdown = [];
    for (const [proj, items] of Object.entries(tasks)) {
        myTotal += items.length;
        projBreakdown.push(`${proj}:${items.length}`);
    }

    if (myTotal !== exp) {
        discCount++;
        const diff = myTotal - exp;
        const repDiff = rep != null ? rep - exp : '?';
        console.log(`\n❌ #${discCount} ${person}`);
        console.log(`   Diagnostic: ${myTotal} | Report: ${rep} | Check tay: ${exp} | Δ(diag-exp): ${diff > 0 ? '+' : ''}${diff} | Δ(rep-exp): ${repDiff > 0 ? '+' : ''}${repDiff}`);
        console.log(`   Breakdown: ${projBreakdown.join(', ')}`);

        // For small diff, list status breakdown per project
        for (const [proj, items] of Object.entries(tasks)) {
            const statusMap = {};
            for (const it of items) { statusMap[it.status || '(empty)'] = (statusMap[it.status || '(empty)'] || 0) + 1; }
            console.log(`   ${proj} (${items.length}): ${JSON.stringify(statusMap)}`);
        }

        // Check if person has tasks in projects listed as "Dự án thiếu"
        const projKeys = Object.keys(tasks);
        const allProjects = ['SUN', 'MAM', 'IMM', 'GEN', 'MIR', 'XAN', 'GUI', 'LEG', 'HAR', 'FCM', 'OTH4'];
        const missing = allProjects.filter(p => !projKeys.includes(p));
        if (missing.length > 0) {
            console.log(`   Missing projects: ${missing.join(', ')}`);
        }
    }
}

console.log(`\n\n=== SUMMARY: ${discCount} discrepancies found ===`);

// Also check if there are unmapped people with tasks
console.log('\n=== UNRESOLVED NAMES (tasks counted but not in SENIORITY_MAPPING) ===');
for (const name of [...unresolvedNames].sort()) {
    const tasks = personTasks[name] || {};
    let total = 0;
    for (const items of Object.values(tasks)) total += items.length;
    console.log(`  "${name}" (${total} tasks in Jan): ${Object.entries(tasks).map(([p, i]) => `${p}:${i.length}`).join(', ')}`);
}

// Check specific people in specific databases for debugging
console.log('\n\n=== DETAILED DB-LEVEL CHECK FOR KEY PEOPLE ===');

const keyPeople = [
    { name: 'Đoàn Anh Kiệt', notionNames: ['Kiệt Đoàn'], missingDb: ['FCM', 'GUI'] },
    { name: 'Nguyễn Thị Hoàng My', notionNames: ['My Nguyễn'], missingDb: ['GUI'] },
    { name: 'Đỗ Thành Trung', notionNames: ['Trung Đỗ'], missingDb: ['FCM'] },
    { name: 'Đinh Trí Bảo Anh', notionNames: ['Bảo Anh'], missingDb: ['FCM'] },
    { name: 'Nguyễn Thị Hòa', notionNames: ['Hòa Nguyễn'], missingDb: ['LEG'] },
    { name: 'Hà Huy Hoàng', notionNames: ['Hoàng Hà'], missingDb: ['HAR'] },
    { name: 'Trần Thị Hồng Nhung', notionNames: ['Nhung Trần'], missingDb: [] },
];

// Check each Task database for these people
const dbMap = {};
for (const d of taskDbIds) dbMap[d.code] = d;

for (const kp of keyPeople) {
    console.log(`\n--- ${kp.name} ---`);
    for (const dbCode of ['SUN', 'MAM', 'IMM', 'GEN', 'MIR', 'XAN', 'GUI', 'LEG', 'HAR', 'FCM', 'OTH4']) {
        const dbInfo = dbMap[dbCode];
        if (!dbInfo) continue;
        const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
        if (!fs.existsSync(cacheFile)) continue;
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (!Array.isArray(data)) continue;
        const dbn = String(data[0]?.database_name || '').toLowerCase();
        if (!dbn.includes('task')) continue;

        let count = 0, noDate = 0, outRange = 0;
        for (const task of data) {
            const assignees = getAssignees(task);
            if (!assignees.includes(kp.name)) continue;
            const dt = parseDate(task);
            if (!dt) { noDate++; continue; }
            if (dt < START || dt > END) { outRange++; continue; }
            count++;
        }
        if (count > 0 || noDate > 0 || outRange > 0) {
            console.log(`  ${dbCode}: inRange=${count}, noDate=${noDate}, outRange=${outRange}`);
        }
    }
}
