import fs from 'fs';

const data = JSON.parse(fs.readFileSync('data/cache/28fccb0e-ac88-813d-a92a-f913c8e96f8d.json', 'utf8'));

function extractFirstText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map(extractFirstText).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        // Notion date objects: {start: "2025-10-21", end: null}
        if (value.start !== undefined && typeof value.start === 'string') {
            return value.start;
        }
        if (value.type && value[value.type] !== undefined) {
            return extractFirstText(value[value.type]);
        }
        if (value.name) return String(value.name).trim();
        if (value.plain_text) return String(value.plain_text).trim();
    }
    return '';
}

function findRecordProp(record, candidates) {
    if (!record || typeof record !== 'object') return '';
    for (const key of candidates) {
        if (record[key] !== undefined) {
            const v = extractFirstText(record[key]);
            if (v) return v;
        }
    }
    const props = record.properties && typeof record.properties === 'object' ? record.properties : null;
    if (props) {
        for (const key of candidates) {
            if (props[key] !== undefined) {
                const v = extractFirstText(props[key]);
                if (v) return v;
            }
        }
    }
    return '';
}

// STRICT: Only Ngày làm, no created_time fallback
function extractCreatedDate(record) {
    return findRecordProp(record, [
        'Ngày làm', 'NGÀY LÀM', 'Work Date', 'DoneDate', 'Done Date',
        'Date', 'Ngày', 'Thời gian'
    ]);
}

function isDateInRange(dateStr, start, end) {
    if (!dateStr || !start || !end) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    return d >= start && d < end;
}

// Test Feb 2026 (tháng này)
const feb2026Start = new Date(2026, 1, 1);
const feb2026End = new Date(2026, 2, 1);

let feb2026Count = 0;
const byAssignee = new Map();

data.forEach(r => {
    const dateStr = extractCreatedDate(r);
    if (!dateStr || !isDateInRange(dateStr, feb2026Start, feb2026End)) return;
    feb2026Count++;
    const assignee = findRecordProp(r, ['Assignee']) || '?';
    byAssignee.set(assignee, (byAssignee.get(assignee) || 0) + 1);
});

console.log(`=== THÁNG NÀY (Feb 2026) ===`);
console.log(`Total matching: ${feb2026Count} (Dashboard shows: 654)`);
console.log(`\nTop 5 assignees:`);
[...byAssignee.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([name, count], i) => console.log(`  ${i + 1}. ${name}: ${count} task`));

// Test Jan 2026 (tháng trước)
const jan2026Start = new Date(2026, 0, 1);
const jan2026End = new Date(2026, 1, 1);
let jan2026Count = 0;
data.forEach(r => {
    const dateStr = extractCreatedDate(r);
    if (dateStr && isDateInRange(dateStr, jan2026Start, jan2026End)) jan2026Count++;
});
console.log(`\n=== THÁNG TRƯỚC (Jan 2026) ===`);
console.log(`Total matching: ${jan2026Count}`);
