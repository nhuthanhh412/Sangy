/**
 * Focused diagnostic: ONLY show people where report < check tay (thiếu task)
 * Only care about tasks with Ngày làm in January 2026
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');
const PRIORITY_FILE = path.join(__dirname, 'data/priority_projects.json');
const META_FILE = path.join(__dirname, 'data/metadata.json');

import { SENIORITY_MAPPING, NAME_ALIAS_MAPPING } from './src/constants.js';

// Check freshness
const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
console.log(`📅 Last data refresh: ${meta.last_refresh}`);
console.log(`📅 Current time: ${new Date().toISOString()}`);
const minutesAgo = Math.round((Date.now() - new Date(meta.last_refresh).getTime()) / 60000);
console.log(`⏱ Data age: ${minutesAgo} minutes\n`);

// Check per-database sync times for Task databases
const priority = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf-8'));
const taskDbIds = [];
for (const proj of priority.projects) {
    for (const db of proj.databases) {
        if (db.type === 'tasks' || db.name.toLowerCase().includes('task'))
            taskDbIds.push({ id: db.id, name: db.name, code: proj.code });
    }
}

console.log('=== DATABASE SYNC TIMES ===');
for (const dbInfo of taskDbIds) {
    const syncTime = meta.sync_times?.[dbInfo.id];
    const age = syncTime ? Math.round((Date.now() - new Date(syncTime).getTime()) / 60000) : 'NEVER';
    console.log(`  ${dbInfo.code}: ${syncTime || 'NEVER'} (${age} min ago)`);
}

// === Utils ===
function removeAccents(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function normalizePersonName(name) {
    return removeAccents(String(name || '').toLowerCase().replace(/đ/g, 'd'))
        .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
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
function getAssignees(task) {
    const props = task.properties || {};
    for (const key of ['Assignee', 'Owner', 'assignee', 'owner', 'Người thực hiện']) {
        if (!props[key]) continue;
        if (Array.isArray(props[key])) return props[key].map(p => resolvePersonName(p?.name || '')).filter(Boolean);
        if (typeof props[key] === 'string') { const r = resolvePersonName(props[key]); return r ? [r] : []; }
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

// Cases where report < check tay (THIẾU)
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

// Count tasks per person per project
const personTasks = {};
for (const dbInfo of taskDbIds) {
    const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
    if (!fs.existsSync(cacheFile)) continue;
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) continue;
    const dbName = String(data[0]?.database_name || '').toLowerCase();
    if (!dbName.includes('task')) continue;
    for (const task of data) {
        const dt = parseDate(task);
        if (!dt || dt < START || dt > END) continue;
        const assignees = getAssignees(task);
        for (const person of assignees) {
            if (!shortfallCases[person]) continue;
            if (!personTasks[person]) personTasks[person] = {};
            if (!personTasks[person][dbInfo.code]) personTasks[person][dbInfo.code] = 0;
            personTasks[person][dbInfo.code]++;
        }
    }
}

console.log('\n\n=== THIẾU TASK: Report < Check tay ===\n');
for (const [person, expected] of Object.entries(shortfallCases)) {
    const tasks = personTasks[person] || {};
    let total = 0;
    const parts = [];
    for (const [proj, cnt] of Object.entries(tasks)) { total += cnt; parts.push(`${proj}:${cnt}`); }
    const diff = expected - total;
    if (diff > 0) {
        console.log(`❌ ${person}: Report=${total}, Check tay=${expected}, THIẾU ${diff} task`);
        console.log(`   Có: ${parts.join(', ')}`);
    } else {
        console.log(`✅ ${person}: Report=${total}, Check tay=${expected} → ĐÃ KHỚP`);
    }
}
