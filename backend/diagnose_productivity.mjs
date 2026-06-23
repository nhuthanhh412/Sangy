/**
 * Diagnostic: analyze January 2026 task counts per person
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

// Collect Task database IDs
const taskDbIds = [];
for (const proj of priority.projects) {
    for (const db of proj.databases) {
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task')) {
            taskDbIds.push({ id: db.id, name: db.name, project: proj.name, code: proj.code });
        }
    }
}

console.log('=== TASK DATABASES ===');
taskDbIds.forEach(d => console.log(`  ${d.code}: ${d.name} (${d.id})`));

function removeAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
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
    for (const key of keys) {
        if (props[key]) { assignees = props[key]; break; }
    }
    if (!assignees) return [];
    if (Array.isArray(assignees)) {
        return assignees.map(p => resolvePersonName(p?.name || '')).filter(Boolean);
    }
    if (typeof assignees === 'string') {
        const r = resolvePersonName(assignees);
        return r ? [r] : [];
    }
    return [];
}

function getPropertyValue(task, ...propNames) {
    const props = task.properties;
    if (!props) return null;
    for (const propName of propNames) {
        let value = props[propName];
        if (value == null) {
            const lowerName = propName.toLowerCase();
            const matchingKey = Object.keys(props).find(k => k.toLowerCase() === lowerName);
            if (matchingKey) value = props[matchingKey];
        }
        if (value != null) return extractValue(value);
    }
    return null;
}

function extractValue(value) {
    if (value == null) return null;
    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        if (value[0] && typeof value[0] === 'object') {
            const first = value[0];
            if (first.type === 'formula' && first.formula) {
                const f = first.formula;
                return f.string ?? f.number ?? f.boolean ?? null;
            }
            if (first.type === 'select' && first.select) return first.select.name || null;
            if (first.type === 'status' && first.status) return first.status.name || null;
            if (first.type === 'number') return first.number;
            if (first.type === 'text' || first.plain_text !== undefined) {
                return value.map(v => v.plain_text || '').join('');
            }
        }
        if (typeof value[0] !== 'object') return value.join(', ');
    }
    return value;
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
            if (dv.type === 'formula') { dv = (dv.formula || {}).string || (dv.formula || {}).date || null; }
            else if (dv.type === 'rollup') {
                if (Array.isArray(dv.rollup?.array)) {
                    const arr = dv.rollup.array; const last = arr[arr.length - 1];
                    dv = last?.start || last?.formula?.string || last || null;
                } else dv = null;
            } else if (dv.type === 'date' && dv.date) { dv = dv.date; }
            else if (Array.isArray(dv.rich_text)) { dv = dv.rich_text[0]?.plain_text || null; }
            else if (Array.isArray(dv.title)) { dv = dv.title[0]?.plain_text || null; }
        }
        if (!dv) return null;
        if (typeof dv === 'object' && dv.start) {
            const ds = dv.end || dv.start; const p = new Date(ds);
            return Number.isNaN(p.getTime()) ? null : p;
        }
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

const personStats = {};
const unresolvedNames = new Set();

for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    if (!fs.existsSync(cacheFile)) { console.log(`⚠ Missing: ${dbInfo.name}`); continue; }
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) { console.log(`⚠ Empty: ${dbInfo.name}`); continue; }

    const dbName = data[0]?.database_name || dbInfo.name;
    const dbNameLower = String(dbName).toLowerCase();
    if (!dbNameLower.includes('task')) { console.log(`  SKIP (no 'task' in name): ${dbName}`); continue; }

    const sampleProps = data[0]?.properties || {};
    const nk = (k) => removeAccents(String(k || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
    const ngayLamCol = Object.keys(sampleProps).find(k => nk(k) === 'ngay lam');

    let cntInRange = 0, cntNoDate = 0, cntOutRange = 0, cntNoAssignee = 0;

    for (const task of data) {
        const status = getPropertyValue(task, 'Task Status') || getPropertyValue(task, 'Status');
        const statusLower = String(status || '').toLowerCase();
        const isDone = statusLower === 'done' || statusLower === 'done qc' || statusLower === 'done others';

        const doneDate = parseDate(task);
        if (!doneDate) { cntNoDate++; continue; }
        if (doneDate < START || doneDate > END) { cntOutRange++; continue; }

        const assignees = getAssignees(task);
        if (assignees.length === 0) { cntNoAssignee++; continue; }
        cntInRange++;

        for (const person of assignees) {
            if (!personStats[person]) personStats[person] = {};
            if (!personStats[person][dbInfo.code]) {
                personStats[person][dbInfo.code] = { done: 0, doneQC: 0, doneOthers: 0, other: 0, total: 0 };
            }
            const ps = personStats[person][dbInfo.code];
            ps.total++;
            if (statusLower === 'done') ps.done++;
            else if (statusLower === 'done qc') ps.doneQC++;
            else if (statusLower === 'done others') ps.doneOthers++;
            else ps.other++;

            if (!SENIORITY_MAPPING[person]) unresolvedNames.add(person);
        }
    }

    console.log(`\nDB: ${dbInfo.code} "${dbName}"`);
    console.log(`   Total=${data.length} InRange=${cntInRange} NoDate=${cntNoDate} OutRange=${cntOutRange} NoAssignee=${cntNoAssignee} NgayLam=${ngayLamCol || 'MISSING!'}`);
}

console.log('\n\n=== UNRESOLVED NAMES ===');
for (const n of [...unresolvedNames].sort()) console.log(`  "${n}"`);

console.log('\n=== COMPARISON: Done+DoneQC+DoneOthers vs Expected ===');
console.log(`${'Person'.padEnd(35)} | ${'Done'.padStart(5)} | ${'All'.padStart(5)} | ${'Exp'.padStart(5)} | ${'Δ'.padStart(5)} | Projects`);
console.log('-'.repeat(110));

const allPersons = [...new Set([...Object.keys(personStats), ...Object.keys(expectedCounts)])].sort();
for (const person of allPersons) {
    const stats = personStats[person] || {};
    let totalDone = 0, totalAll = 0;
    const projParts = [];
    for (const [proj, s] of Object.entries(stats)) {
        const dc = s.done + s.doneQC + s.doneOthers;
        totalDone += dc;
        totalAll += s.total;
        projParts.push(`${proj}:${dc}/${s.total}`);
    }
    const exp = expectedCounts[person];
    const diff = exp != null ? totalDone - exp : '';
    const flag = (exp != null && totalDone !== exp) ? ' ❌' : '';
    console.log(`${person.padEnd(35)} | ${String(totalDone).padStart(5)} | ${String(totalAll).padStart(5)} | ${String(exp ?? '-').padStart(5)} | ${String(diff).padStart(5)} | ${projParts.join(', ')}${flag}`);
}

// Detailed breakdown for discrepancies
console.log('\n=== DISCREPANCY DETAILS ===');
for (const person of allPersons) {
    const exp = expectedCounts[person];
    const stats = personStats[person] || {};
    let totalDone = 0;
    for (const s of Object.values(stats)) totalDone += s.done + s.doneQC + s.doneOthers;
    if (exp != null && totalDone !== exp) {
        console.log(`\n❌ ${person}: Got=${totalDone}, Expected=${exp}, Diff=${totalDone - exp}`);
        for (const [proj, s] of Object.entries(stats)) {
            console.log(`   ${proj}: Done=${s.done} DoneQC=${s.doneQC} DoneOthers=${s.doneOthers} Other=${s.other}`);
        }
    }
}
