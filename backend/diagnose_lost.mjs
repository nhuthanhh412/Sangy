/**
 * Find the EXACT tasks that are being lost.
 * Compare raw cache data vs parseDate results for each shortfall person.
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
    for (const c of Object.keys(SENIORITY_MAPPING)) { const nc = normalizePersonName(c); if (nc && nr.includes(nc)) return c; }
    return raw;
}

function getAssigneesRaw(task) {
    const props = task.properties || {};
    for (const key of ['Assignee', 'Owner', 'assignee', 'owner', 'Người thực hiện']) {
        if (!props[key]) continue;
        if (Array.isArray(props[key])) return props[key].map(p => ({ raw: p?.name || '', resolved: resolvePersonName(p?.name || '') }));
        if (typeof props[key] === 'string') return [{ raw: props[key], resolved: resolvePersonName(props[key]) }];
    }
    return [];
}

// === EXACT SAME parseDate as productivity.js ===
function parseDate(task) {
    const props = task.properties; if (!props) return { date: null, reason: 'no props' };
    const nk = (k) => removeAccents(String(k || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
    const entry = Object.entries(props).find(([k]) => nk(k) === 'ngay lam');
    if (!entry) return { date: null, reason: 'no ngay lam column' };

    let dv = entry[1];
    if (dv == null || dv === '') return { date: null, reason: 'ngay lam is null/empty', raw: dv };
    if (Array.isArray(dv) && dv.length === 0) return { date: null, reason: 'ngay lam is empty array', raw: dv };

    const origDv = JSON.stringify(dv).slice(0, 200);

    if (typeof dv === 'object') {
        if (dv.type === 'formula') {
            const f = dv.formula || {};
            dv = f.string || f.date || f.number || null;
            if (!dv) return { date: null, reason: 'formula returned null', raw: origDv };
        }
        else if (dv.type === 'rollup' && Array.isArray(dv.rollup?.array)) {
            const a = dv.rollup.array; dv = a[a.length - 1]?.start || null;
            if (!dv) return { date: null, reason: 'rollup returned null', raw: origDv };
        }
        else if (dv.type === 'date' && dv.date) { dv = dv.date; }
        else if (Array.isArray(dv.rich_text)) { dv = dv.rich_text[0]?.plain_text || null; }
        else if (Array.isArray(dv.title)) { dv = dv.title[0]?.plain_text || null; }
    }

    if (!dv) return { date: null, reason: 'value became null after type extraction', raw: origDv };

    if (typeof dv === 'object' && dv.start) {
        const dateStr = dv.end || dv.start;
        const parsed = new Date(dateStr);
        if (isNaN(parsed.getTime())) return { date: null, reason: `invalid date string: ${dateStr}`, raw: origDv };
        return { date: parsed, reason: 'ok', raw: origDv };
    }

    if (typeof dv === 'string') {
        const p = new Date(dv.trim());
        if (isNaN(p.getTime())) return { date: null, reason: `unparseable string: ${dv}`, raw: origDv };
        return { date: p, reason: 'ok', raw: origDv };
    }

    return { date: null, reason: `unhandled type: ${typeof dv}`, raw: origDv };
}

const START = new Date('2026-01-01');
const END = new Date('2026-01-31T23:59:59.999');

const shortfallCases = {
    'Nguyễn Bích Ngọc': { exp: 57, shorts: ['Ngọc Nguyễn'] },
    'Lê Hoàng Quốc Anh': { exp: 65, shorts: ['Quốc Anh'] },
    'Nguyễn Xuân Yến': { exp: 54, shorts: ['Yến Nguyễn'] },
    'Lường Thanh Bình': { exp: 35, shorts: ['Bình Lường'] },
    'Nguyễn Thị Hòa': { exp: 150, shorts: ['Hòa Nguyễn'] },
    'Đỗ Thành Trung': { exp: 285, shorts: ['Trung Đỗ'] },
    'Nguyễn Thị Hoàng My': { exp: 98, shorts: ['My Nguyễn'] },
    'Trần Thị Hồng Nhung': { exp: 106, shorts: ['Nhung Trần'] },
    'Đinh Trí Bảo Anh': { exp: 104, shorts: ['Bảo Anh'] },
    'Đoàn Anh Kiệt': { exp: 448, shorts: ['Kiệt Đoàn'] },
    'Hà Huy Hoàng': { exp: 89, shorts: ['Hoàng Hà'] },
    'Nguyễn Trường Phúc': { exp: 59, shorts: ['Phúc Nguyễn'] },
};

for (const [canonName, info] of Object.entries(shortfallCases)) {
    const normShorts = info.shorts.map(s => normalizePersonName(s));
    const normCanon = normalizePersonName(canonName);

    let totalCounted = 0;
    let totalRaw = 0; // tasks that have this assignee + Ngày làm seems to be in Jan (raw check)
    const lostTasks = [];

    for (const dbInfo of taskDbIds) {
        const cacheFile = path.join(CACHE_DIR, `${dbInfo.id}.json`);
        if (!fs.existsSync(cacheFile)) continue;
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (!Array.isArray(data)) continue;
        const dbNameL = String(data[0]?.database_name || '').toLowerCase();
        if (!dbNameL.includes('task')) continue;

        for (const task of data) {
            // Check if this person is assigned
            const assignees = getAssigneesRaw(task);
            let isAssigned = false;
            for (const a of assignees) {
                if (a.resolved === canonName) { isAssigned = true; break; }
                const nr = normalizePersonName(a.raw);
                if (nr === normCanon || normShorts.includes(nr)) { isAssigned = true; break; }
            }
            if (!isAssigned) continue;

            // Parse date with detailed reason
            const { date, reason, raw } = parseDate(task);

            if (!date) {
                // Task belongs to person but has no valid date — skip silently
                continue;
            }

            if (date >= START && date <= END) {
                totalCounted++;
            } else {
                // Has date but outside Jan — check if it's CLOSE to Jan (potential edge case)
                const dateStr = date.toISOString().slice(0, 10);
                // Don't show — user said only care about Jan
            }

            // Also do raw check: does property have a date-like value in Jan?
            // This catches cases where parseDate uses end date but raw has start in Jan
            const props = task.properties || {};
            const nk = (k) => removeAccents(String(k || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
            const ngayLamEntry = Object.entries(props).find(([k]) => nk(k) === 'ngay lam');
            if (ngayLamEntry) {
                const rawVal = ngayLamEntry[1];
                const rawStr = JSON.stringify(rawVal);
                // Check if raw contains 2026-01
                if (rawStr.includes('2026-01')) {
                    totalRaw++;
                    if (!(date >= START && date <= END)) {
                        // Task has 2026-01 in raw date but parseDate put it outside Jan!
                        lostTasks.push({
                            db: dbInfo.code,
                            title: (task._title || '').slice(0, 60),
                            dateRaw: rawStr.slice(0, 150),
                            parsedDate: date?.toISOString().slice(0, 10),
                            reason: reason
                        });
                    }
                }
            }
        }
    }

    const diff = info.exp - totalCounted;
    if (diff <= 0) continue;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`❌ ${canonName}: Đếm được ${totalCounted}, Check tay ${info.exp}, THIẾU ${diff}`);
    console.log(`   Raw tasks with "2026-01" in Ngày làm: ${totalRaw}`);

    if (lostTasks.length > 0) {
        console.log(`   🔍 Tasks có "2026-01" trong Ngày làm nhưng BỊ BỎ QUA:`);
        for (const t of lostTasks) {
            console.log(`      ${t.db} | "${t.title}" | parsed=${t.parsedDate} | raw=${t.dateRaw}`);
        }
    }

    if (totalRaw === totalCounted && totalRaw < info.exp) {
        console.log(`   ⚠ Cache chỉ có ${totalRaw} task với "2026-01" trong Ngày làm (thiếu ${info.exp - totalRaw} task trong cache)`);
    }
}
