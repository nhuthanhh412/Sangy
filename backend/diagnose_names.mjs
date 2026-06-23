/**
 * Diagnostic: trace name resolution for specific people in specific databases
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, 'data/cache');

import { SENIORITY_MAPPING, NAME_ALIAS_MAPPING } from './src/constants.js';

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

// Test specific names from FCM database
const testNames = [
    'Hưng Nguyễn', 'Minh Ngô  ', 'Bảo Anh', 'Kiệt Đoàn', 'My Nguyễn',
    'Thi Hoàng', 'Thu Lê', 'Trung Đỗ', 'Minh Anh Nguyen Pham',
    'Hoàng Hà', 'Kiên Đoàn', 'Linh Nguyễn', 'Lộc Nguyễn', 'Trinh Ngụy',
    'Hòa Nguyễn',
    // GUI
    'Vân Trần', 'Huy Đỗ', 'Nhung Trần', 'Quỳnh Trương', 'Yến Nguyễn',
];

console.log('=== NAME RESOLUTION TEST ===');
for (const name of testNames) {
    const resolved = resolvePersonName(name);
    const inMapping = !!SENIORITY_MAPPING[resolved];
    const flag = !inMapping ? ' ⚠ NOT IN SENIORITY_MAPPING' : '';
    console.log(`  "${name}" → "${resolved}"${resolved !== name ? ' ✓ mapped' : ' ❌ NOT MAPPED'}${flag}`);
}

// Check all names in NAME_ALIAS_MAPPING that contain key names
console.log('\n=== CHECKING ALIAS MAPPING ===');
const keysToCheck = ['Hưng', 'Minh Ngô', 'Thi Hoàng', 'Thu Lê', 'Trinh', 'Hòa Nguyễn', 'Hoàng Hà'];
for (const partial of keysToCheck) {
    const matches = Object.entries(NAME_ALIAS_MAPPING).filter(([k, v]) =>
        k.includes(partial) || v.includes(partial)
    );
    if (matches.length > 0) {
        console.log(`  "${partial}":`);
        matches.forEach(([k, v]) => console.log(`    "${k}" → "${v}"`));
    } else {
        console.log(`  "${partial}": ❌ NO MATCHES IN ALIAS MAPPING`);
    }
}

// Check who's in FCM that we SHOULD count
console.log('\n=== FCM DATABASE - DETAILED ANALYSIS ===');
const fcmFile = path.join(CACHE_DIR, '2edccb0e-ac88-815c-a6de-c98c5d033c02.json');
const fcmData = JSON.parse(fs.readFileSync(fcmFile, 'utf-8'));

const START = new Date('2026-01-01');
const END = new Date('2026-01-31T23:59:59.999');

const fcmStats = {};
for (const task of fcmData) {
    const props = task.properties || {};
    const assigneeProp = props['Assignee'];
    if (!assigneeProp || !Array.isArray(assigneeProp)) continue;

    // Get date
    const dateProp = props['Ngày làm'];
    let taskDate = null;
    if (dateProp) {
        if (dateProp.start) taskDate = new Date(dateProp.end || dateProp.start);
        else if (dateProp.type === 'date' && dateProp.date) taskDate = new Date(dateProp.date.end || dateProp.date.start);
    }

    const inRange = taskDate && taskDate >= START && taskDate <= END;

    for (const a of assigneeProp) {
        const rawName = a?.name || '';
        if (!rawName) continue;
        const resolved = resolvePersonName(rawName);

        if (!fcmStats[rawName]) fcmStats[rawName] = { resolved, inRange: 0, outRange: 0, noDate: 0, statuses: {} };

        const statusProp = props['Task Status'];
        let status = '';
        if (statusProp?.status) status = statusProp.status.name;
        else if (statusProp?.select) status = statusProp.select.name;

        fcmStats[rawName].statuses[status] = (fcmStats[rawName].statuses[status] || 0) + 1;

        if (!taskDate) fcmStats[rawName].noDate++;
        else if (inRange) fcmStats[rawName].inRange++;
        else fcmStats[rawName].outRange++;
    }
}

for (const [raw, s] of Object.entries(fcmStats)) {
    console.log(`  "${raw}" → "${s.resolved}" | InRange: ${s.inRange}, OutRange: ${s.outRange}, NoDate: ${s.noDate} | Statuses: ${JSON.stringify(s.statuses)}`);
}
