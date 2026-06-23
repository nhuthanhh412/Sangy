/**
 * Deep dive: for each shortfall person, find ALL their tasks in ALL databases
 * with Ngày làm in January 2026. Show project-by-project task list.
 * Check if there are tasks assigned to them that DON'T resolve correctly.
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
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task'))
            taskDbIds.push({ id: db.id, name: db.name, code: proj.code });
    }
}

function removeAccents(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function normalizePersonName(name) {
    return removeAccents(String(name || '').toLowerCase().replace(/đ/g, 'd')).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
const personAliasMap = new Map();
for (const [a, c] of Object.entries(NAME_ALIAS_MAPPING)) { const n = normalizePersonName(a); if (n && !personAliasMap.has(n)) personAliasMap.set(n, c); }
for (const c of Object.keys(SENIORITY_MAPPING)) { const n = normalizePersonName(c); if (n && !personAliasMap.has(n)) personAliasMap.set(n, c); }
function resolvePersonName(rawName) {
    const raw = String(rawName || '').trim(); if (!raw) return '';
    if (NAME_ALIAS_MAPPING[raw]) return NAME_ALIAS_MAPPING[raw];
    const nr = normalizePersonName(raw); const fm = personAliasMap.get(nr); if (fm) return fm;
    const stripped = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped !== raw) { if (NAME_ALIAS_MAPPING[stripped]) return NAME_ALIAS_MAPPING[stripped]; const ns = normalizePersonName(stripped); const sm = personAliasMap.get(ns); if (sm) return sm; }
    for (const c of Object.keys(SENIORITY_MAPPING)) { const nc = normalizePersonName(c); if (nc && nr.includes(nc)) return c; }
    return raw;
}

function getRawAssignees(task) {
    const props = task.properties || {};
    for (const key of ['Assignee', 'Owner', 'assignee', 'owner', 'Người thực hiện']) {
        if (!props[key]) continue;
        if (Array.isArray(props[key])) return props[key].map(p => ({ raw: p?.name || '', resolved: resolvePersonName(p?.name || '') })).filter(x => x.raw);
        if (typeof props[key] === 'string') return [{ raw: props[key], resolved: resolvePersonName(props[key]) }];
    }
    return [];
}

function parseDate(task) {
    const props = task.properties; if (!props) return null;
    const nk = (k) => removeAccents(String(k || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
    const entry = Object.entries(props).find(([k]) => nk(k) === 'ngay lam');
    if (!entry) return null;
    let dv = entry[1]; if (dv == null || dv === '') return null;
    if (typeof dv === 'object') {
        if (dv.type === 'formula') { dv = (dv.formula || {}).string || (dv.formula || {}).date || null; }
        else if (dv.type === 'rollup' && Array.isArray(dv.rollup?.array)) { const a = dv.rollup.array; dv = a[a.length - 1]?.start || null; }
        else if (dv.type === 'date' && dv.date) { dv = dv.date; }
    }
    if (!dv) return null;
    if (typeof dv === 'object' && dv.start) { const p = new Date(dv.end || dv.start); return isNaN(p.getTime()) ? null : p; }
    if (typeof dv === 'string') { const p = new Date(dv.trim()); return isNaN(p.getTime()) ? null : p; }
    return null;
}

const START = new Date('2026-01-01');
const END = new Date('2026-01-31T23:59:59.999');

// Map of Notion short names known for each person
const shortNames = {
    'Nguyễn Bích Ngọc': ['Ngọc Nguyễn'],
    'Lê Hoàng Quốc Anh': ['Quốc Anh'],
    'Nguyễn Xuân Yến': ['Yến Nguyễn'],
    'Lường Thanh Bình': ['Bình Lường'],
    'Nguyễn Thị Hòa': ['Hòa Nguyễn'],
    'Đỗ Thành Trung': ['Trung Đỗ'],
    'Nguyễn Thị Hoàng My': ['My Nguyễn'],
    'Trần Thị Hồng Nhung': ['Nhung Trần'],
    'Đinh Trí Bảo Anh': ['Bảo Anh'],
    'Đoàn Anh Kiệt': ['Kiệt Đoàn'],
    'Hà Huy Hoàng': ['Hoàng Hà'],
    'Nguyễn Trường Phúc': ['Phúc Nguyễn'],
};

const shortfallCases = {
    'Nguyễn Bích Ngọc': 57,
    'Lê Hoàng Quốc Anh': 65,
    'Nguyễn Xuân Yến': 54,
    'Lường Thanh Bình': 35,
    'Nguyễn Thị Hòa': 150,
    'Đỗ Thành Trung': 285,
    'Nguyễn Thị Hoàng My': 98,
    'Trần Thị Hồng Nhung': 106,
    'Đinh Trí Bảo Anh': 104,
    'Đoàn Anh Kiệt': 448,
    'Hà Huy Hoàng': 89,
    'Nguyễn Trường Phúc': 59,
};

// For each shortfall person, scan ALL task databases and find tasks
// Check BOTH by resolved name AND by raw short name
for (const [canonName, expected] of Object.entries(shortfallCases)) {
    const knownShorts = shortNames[canonName] || [];
    const normCanon = normalizePersonName(canonName);
    const normShorts = knownShorts.map(s => normalizePersonName(s));

    let total = 0;
    const projCounts = {};

    for (const dbInfo of taskDbIds) {
        const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
        if (!fs.existsSync(cacheFile)) continue;
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (!Array.isArray(data) || data.length === 0) continue;
        const dbNameL = String(data[0]?.database_name || '').toLowerCase();
        if (!dbNameL.includes('task')) continue;

        let count = 0;
        for (const task of data) {
            const dt = parseDate(task);
            if (!dt || dt < START || dt > END) continue;

            // Check all assignees: by resolved name AND by raw short name match
            const rawAssignees = getRawAssignees(task);
            let match = false;
            for (const a of rawAssignees) {
                if (a.resolved === canonName) { match = true; break; }
                const normRaw = normalizePersonName(a.raw);
                if (normRaw === normCanon || normShorts.includes(normRaw)) { match = true; break; }
            }
            if (match) count++;
        }

        if (count > 0) {
            projCounts[dbInfo.code] = count;
            total += count;
        }
    }

    const diff = expected - total;
    if (diff > 0) {
        console.log(`\n❌ ${canonName}: Found ${total}, Expected ${expected}, THIẾU ${diff}`);
        console.log(`   ${Object.entries(projCounts).map(([p, c]) => `${p}:${c}`).join(', ')}`);
    } else {
        console.log(`\n✅ ${canonName}: Found ${total}, Expected ${expected} — OK`);
    }
}

// === EXTRA: Search for tasks belonging to ANY shortfall person by raw Notion name ===
console.log('\n\n=== SEARCHING BY ALL RAW ASSIGNEE NAMES ===');
// For each DB, list all unique raw assignee names for tasks in Jan range
const allRawNames = new Map(); // rawName -> { resolved, tasks: [{db, title}] }
for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    if (!fs.existsSync(cacheFile)) continue;
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!Array.isArray(data)) continue;
    const dbNameL = String(data[0]?.database_name || '').toLowerCase();
    if (!dbNameL.includes('task')) continue;

    for (const task of data) {
        const dt = parseDate(task);
        if (!dt || dt < START || dt > END) continue;
        const rawAssignees = getRawAssignees(task);
        for (const a of rawAssignees) {
            if (!allRawNames.has(a.raw)) allRawNames.set(a.raw, { resolved: a.resolved, dbs: {} });
            const entry = allRawNames.get(a.raw);
            entry.dbs[dbInfo.code] = (entry.dbs[dbInfo.code] || 0) + 1;
        }
    }
}

// Print all raw names whose resolved name matches a shortfall person
const shortfallSet = new Set(Object.keys(shortfallCases));
console.log('\nRaw names that resolve to shortfall people:');
for (const [raw, info] of [...allRawNames.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (shortfallSet.has(info.resolved)) {
        const dbStr = Object.entries(info.dbs).map(([d, c]) => `${d}:${c}`).join(', ');
        console.log(`  "${raw}" → "${info.resolved}" | ${dbStr}`);
    }
}

// Also print ALL raw names alongside their resolved names to spot potential mismatches
console.log('\nALL raw assignee names in Jan 2026 tasks:');
for (const [raw, info] of [...allRawNames.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dbStr = Object.entries(info.dbs).map(([d, c]) => `${d}:${c}`).join(', ');
    const flag = (raw !== info.resolved && !shortfallSet.has(info.resolved) && !SENIORITY_MAPPING[info.resolved]) ? ' ⚠ UNRESOLVED' : '';
    console.log(`  "${raw}" → "${info.resolved}" | ${dbStr}${flag}`);
}
