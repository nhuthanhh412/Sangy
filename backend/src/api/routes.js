import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseDiscovery } from '../notion/discovery.js';
import { DataFetcher } from '../notion/fetcher.js';
import { ProjectsService } from '../notion/projects.js';
import { DatabaseManager } from '../database/db.js';
import { reportRegistry } from '../reports/index.js';
import { ProductivityService } from '../reports/productivity.js';
import { SyncService } from '../notion/sync.js';
import { COLUMNS as PROD_COLUMNS } from '../constants.js';
import { buildFreshnessContract } from '../utils/freshness.js';
import { loadSyncJobs, persistSyncJobs } from '../utils/sync-job-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// In-memory cache for database discovery
let databasesCache = null;
let databasesCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RAW_FORMAT_CACHE_TTL_MS = parseInt(process.env.RAW_FORMAT_CACHE_TTL_MS || '120000', 10);
const RAW_RELATION_RESOLVE_MAX_ROWS = parseInt(process.env.RAW_RELATION_RESOLVE_MAX_ROWS || '400', 10);
const FULL_SYNC_CHECKPOINT_MS = parseInt(process.env.FULL_SYNC_CHECKPOINT_MS || `${6 * 60 * 60 * 1000}`, 10);
const PRODUCTIVITY_LIVE_FALLBACK_PAGE_SIZE = parseInt(process.env.PRODUCTIVITY_LIVE_FALLBACK_PAGE_SIZE || '5', 10);
const rawFormatCache = new Map();

function getRawFormatCacheKey(databaseId, syncTime, options = {}) {
    return [
        databaseId,
        syncTime || 'no-sync-time',
        options.search || '',
        options.sortBy || '',
        options.sortDir || 'asc',
        options.page || 1,
        options.limit || 0,
        options.resolveRelations ? 'resolve' : 'noresolve'
    ].join('::');
}

function pruneRawFormatCache() {
    const now = Date.now();
    for (const [key, entry] of rawFormatCache.entries()) {
        if ((now - entry.createdAt) > RAW_FORMAT_CACHE_TTL_MS) {
            rawFormatCache.delete(key);
        }
    }
}

function normalizeDatePropertyKey(key = '') {
    return String(key)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function fetchTaskRowsForProductivityFallback({ databaseId, startDate, endDate, notionToken, db }) {
    if (!databaseId || !startDate || !endDate || !notionToken) {
        return [];
    }

    const fetcher = new DataFetcher(notionToken, db);
    const dbInfo = await fetcher.client.notion.databases.retrieve({ database_id: databaseId });
    const databaseName = fetcher.extractDatabaseName(dbInfo);
    const projectName = fetcher.extractProjectName(databaseName);
    const dateEntry = Object.entries(dbInfo.properties || {}).find(([name]) => normalizeDatePropertyKey(name) === 'ngay lam');

    if (!dateEntry) {
        console.warn(`[Productivity] Live fallback skipped for ${databaseId}: no "Ngay lam" property found`);
        return [];
    }

    const [datePropertyName, datePropertyMeta] = dateEntry;
    const dateProperty = datePropertyMeta?.id || datePropertyName;
    const filter = {
        and: [
            { property: dateProperty, date: { on_or_after: startDate } },
            { property: dateProperty, date: { on_or_before: endDate } }
        ]
    };

    const rows = [];
    let hasMore = true;
    let startCursor = undefined;
    let pageCount = 0;

    while (hasMore) {
        let attempts = 0;

        while (true) {
            try {
                const response = await fetcher.client.notion.databases.query({
                    database_id: databaseId,
                    start_cursor: startCursor,
                    filter,
                    page_size: PRODUCTIVITY_LIVE_FALLBACK_PAGE_SIZE
                });

                rows.push(...response.results);
                hasMore = response.has_more;
                startCursor = response.next_cursor;
                pageCount += 1;

                if (hasMore) {
                    await fetcher.client.delay(fetcher.client.requestDelay);
                }
                break;
            } catch (error) {
                attempts += 1;
                const retriable = error?.code === 'notionhq_client_request_timeout'
                    || error?.code === 'rate_limited'
                    || /ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(error?.message || '');

                if (!retriable || attempts >= 3) {
                    throw error;
                }

                const backoffMs = Math.pow(2, attempts) * 1000;
                console.warn(`[Productivity] Live fallback retry ${attempts}/3 for ${databaseId} after ${backoffMs}ms: ${error.message}`);
                await fetcher.client.delay(backoffMs);
            }
        }
    }

    console.log(`[Productivity] Live fallback fetched ${rows.length} rows from ${databaseName} (${pageCount} pages)`);

    return rows.map(page => ({
        ...fetcher.transformPage(page),
        database_name: databaseName,
        project_name: projectName,
        database_id: databaseId
    }));
}

function parsePaginationParams(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limitRaw = parseInt(query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : null;
    const sortBy = typeof query.sort_by === 'string' ? query.sort_by : null;
    const sortDir = query.sort_dir === 'desc' ? 'desc' : 'asc';
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
    const resolveRelations = query.resolve_relations !== 'false';
    return { page, limit, sortBy, sortDir, search, resolveRelations };
}

function applyRawFiltersAndPagination(rows, columns, options) {
    let filtered = rows;

    if (options.search) {
        filtered = rows.filter(row =>
            columns.some(col => String(row[col] ?? '').toLowerCase().includes(options.search))
        );
    }

    if (options.sortBy && columns.includes(options.sortBy)) {
        filtered = [...filtered].sort((a, b) => {
            const av = String(a[options.sortBy] ?? '');
            const bv = String(b[options.sortBy] ?? '');
            const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
            return options.sortDir === 'desc' ? -cmp : cmp;
        });
    }

    const totalFiltered = filtered.length;
    if (!options.limit) {
        return {
            data: filtered,
            pagination: {
                page: 1,
                limit: null,
                total_filtered: totalFiltered,
                total_pages: 1
            }
        };
    }

    const totalPages = Math.max(1, Math.ceil(totalFiltered / options.limit));
    const page = Math.min(options.page, totalPages);
    const offset = (page - 1) * options.limit;
    const pageData = filtered.slice(offset, offset + options.limit);

    return {
        data: pageData,
        pagination: {
            page,
            limit: options.limit,
            total_filtered: totalFiltered,
            total_pages: totalPages
        }
    };
}

// Load priority projects whitelist
function loadPriorityProjects() {
    try {
        const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
        if (fs.existsSync(priorityPath)) {
            const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
            return data;
        }
    } catch (error) {
        console.error('[Routes] Warning: Could not load priority_projects.json:', error.message);
    }
    return { projects: [], priority_databases: [] };
}

function normalizeQuery(text = '') {
    return String(text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Expand casual Vietnamese slang/synonyms to standard keywords
function expandSynonyms(q) {
    const map = [
        [/dua nao|thang nao|con nao|nguoi nao/g, 'ai'],
        [/may dua|moi dua|tat ca moi nguoi|ca team/g, 'tung member'],
        [/nhieu nhat|so 1|number one|top 1/g, 'nhieu nhat'],
        [/it nhat|thap nhat/g, 'it nhat'],
        [/thang roi|thang vua roi|thang vua qua/g, 'thang truoc'],
        [/tuan roi|tuan vua roi|tuan vua qua/g, 'tuan truoc'],
        [/hom truoc|hom bua/g, 'hom qua'],
        [/tong diem|diem thuc te/g, 'tong point thuc te'],
        [/diem|taskpoint|task point/g, 'point'],
        [/lam duoc|hoan thanh duoc|xong duoc/g, 'task'],
        [/noi chung|chung chung|tong the|tinh hinh/g, 'tong quan'],
        [/cho xem|show|hien thi/g, ''],
        [/\b(nhe|giup|nha)\b/g, ''],
        // New synonyms for expanded catalog
        [/om nhieu viec|om viec|om nhieu|dang om/g, 'qua tai'],
        [/khong co viec|khong lam gi|ranh rang/g, 'ranh'],
        [/cay duoc|cay nhieu|cay/g, 'nhieu'],
        [/hieu suat|hieu qua/g, 'nang suat'],
        [/tang truong/g, 'cao nhat'],
        [/ton dong|con lai|chua xong|chua xuly/g, 'chua hoan thanh'],
        [/can gap|gap|khan cap/g, 'sap deadline'],
        [/no luc|noluc|nltt/g, 'effort'],
        [/ton nhieu thoi gian/g, 'effort lon'],
        [/lui lich|backlog|de lai/g, 'not started'],
        [/chua qc|xong chua qc/g, 'done chua qc'],
        [/dang chay|dang hoat dong/g, 'in progress'],
        [/chua fix|chua sua/g, 'bug chua hoan thanh'],
        // Extra synonyms for better matching
        [/nang suat nhat|hieu qua nhat|productivity nhat/g, 'nang suat cao nhat'],
        [/so sanh.*du an|du an.*so sanh|workload.*du an|du an.*workload/g, 'so sanh workload du an'],
        [/confirm.*unco|unco.*confirm|confirmed.*unconfirmed|unconfirmed.*confirmed/g, 'so sanh confirmed unconfirmed'],
        [/slay|carry|gánh|ganh/g, 'nhieu nhat'],
    ];
    let result = q;
    for (const [pattern, replacement] of map) {
        result = result.replace(pattern, replacement);
    }
    return result.replace(/\s+/g, ' ').trim();
}


function extractFirstText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(extractFirstText).filter(Boolean);
        return parts.join(', ');
    }
    if (typeof value === 'object') {
        // Notion date objects: {start: "2025-10-21", end: null}
        if (value.start !== undefined && typeof value.start === 'string') {
            return value.start;
        }
        if (Array.isArray(value.people)) {
            const names = value.people
                .map(person => person?.name || person?.person?.email || '')
                .filter(Boolean);
            if (names.length > 0) return names.join(', ');
        }
        if (Array.isArray(value.relation)) {
            const rel = value.relation
                .map(item => item?.id || '')
                .filter(Boolean);
            if (rel.length > 0) return rel.join(', ');
        }
        if (value.type && value[value.type] !== undefined) {
            return extractFirstText(value[value.type]);
        }
        if (value.person && value.person.email) return String(value.person.email).trim();
        if (value.name) return String(value.name).trim();
        if (value.plain_text) return String(value.plain_text).trim();
        if (value.title && Array.isArray(value.title)) {
            return value.title.map(v => v?.plain_text || v?.text?.content || '').filter(Boolean).join('');
        }
        if (value.rich_text && Array.isArray(value.rich_text)) {
            return value.rich_text.map(v => v?.plain_text || v?.text?.content || '').filter(Boolean).join('');
        }
    }
    return '';
}

function extractAssigneeName(record) {
    if (!record || typeof record !== 'object') return '';
    const candidates = [
        'Assignee', 'Assignees', 'assigned_to',
        'Người phụ trách', 'Nguoi phu trach', 'Nhân sự', 'Nhan su',
        'Owner', 'People', 'Person', 'Người thực hiện', 'Nguoi thuc hien'
    ];
    for (const key of candidates) {
        if (record[key] !== undefined) {
            const value = extractFirstText(record[key]);
            if (value) return value;
        }
    }

    const props = (record.properties && typeof record.properties === 'object') ? record.properties : null;
    if (props) {
        for (const key of candidates) {
            if (props[key] !== undefined) {
                const value = extractFirstText(props[key]);
                if (value) return value;
            }
        }
        for (const [key, value] of Object.entries(props)) {
            const normalizedKey = normalizeQuery(key);
            if (
                normalizedKey.includes('assignee') ||
                normalizedKey.includes('owner') ||
                normalizedKey.includes('nguoi') ||
                normalizedKey.includes('nhan su') ||
                normalizedKey.includes('phu trach')
            ) {
                const text = extractFirstText(value);
                if (text) return text;
            }
        }
    }

    for (const [key, value] of Object.entries(record)) {
        const normalizedKey = normalizeQuery(key);
        if (normalizedKey.includes('assignee') || normalizedKey.includes('nguoi') || normalizedKey.includes('nhan su')) {
            const text = extractFirstText(value);
            if (text) return text;
        }
    }
    return '';
}

function extractAssigneeNames(record) {
    const raw = extractAssigneeName(record);
    if (!raw) return [];
    return raw
        .split(',')
        .map(item => item.trim())
        .filter(name =>
            name &&
            name.toLowerCase() !== 'unknown user' &&
            name.toLowerCase() !== 'unknown'
        );
}

// ---- Chat helper: generic property finder ----
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

function extractStatus(record) {
    return findRecordProp(record, [
        'Status', 'Trạng thái', 'Trang thai', 'status', 'STATE', 'State',
        'Task Status', 'Task status', 'TASK STATUS'
    ]);
}

function extractDeadline(record) {
    return findRecordProp(record, [
        'Deadline', 'Due Date', 'Due date', 'due_date', 'End Date', 'end_date',
        'Hạn chót', 'Han chot', 'Ngày hết hạn', 'DUE DATE', 'TARGET DATE',
        'Target Date', 'Finish Date', 'finish_date'
    ]);
}

function extractTaskPoint(record) {
    const v = findRecordProp(record, [
        'Task point', 'task_point', 'TP thực tế', 'TP THỰC TẾ', 'Task Point',
        'TASK POINT', 'Point', 'Points', 'Working hours', 'Task point thực tế',
        'Task point yêu cầu dự án', 'TASK POINT THỰC TẾ'
    ]);
    return parseFloat(v) || 0;
}

function extractEffort(record) {
    const v = findRecordProp(record, [
        'NLTT', 'nltt', 'Actual Effort', 'actual effort', 'Nỗ lực thực tế',
        'NỖ LỰC THỰC TẾ', 'Effort', 'effort', 'Working Days', 'Ngày công'
    ]);
    return parseFloat(v) || 0;
}

function extractPointStatus(record) {
    return findRecordProp(record, [
        'Point Status', 'POINT STATUS', 'point status', 'Confirmation',
        'Xác nhận', 'Confirm Status'
    ]).toLowerCase();
}

function extractTaskProjectName(record) {
    return findRecordProp(record, [
        'DỰ ÁN', 'Dự án', 'Project', 'project', 'Project Name',
        'database_name', 'project_name', 'PROJECT'
    ]);
}

function extractTaskName(record) {
    // Check _title first (common in Notion-synced records)
    if (record?._title) return String(record._title).trim();
    return findRecordProp(record, [
        'TÊN TASK', 'Tên task', 'Task Name', 'task_name', 'Name', 'name',
        'Title', 'title', 'Summary', 'Tên công việc', 'TÊN CÔNG VIỆC'
    ]);
}

function extractTaskType(record) {
    return findRecordProp(record, [
        'Task Type', 'TASK TYPE', 'task_type', 'Loại task', 'Report Type',
        'report_type', 'Type', 'type', 'Category', 'Phân loại'
    ]);
}

function extractCreatedDate(record) {
    // Use ONLY work date fields (matches dashboard filterByDateRange logic exactly)
    // Dashboard uses: findCol('NGÀY LÀM', 'Ngày làm', 'Work Date', 'DoneDate', ...)
    // Records without a valid work date are EXCLUDED from time-filtered results (same as dashboard)
    return findRecordProp(record, [
        'Ngày làm', 'NGÀY LÀM', 'Work Date', 'DoneDate', 'Done Date',
        'Date', 'Ngày', 'Thời gian'
    ]);
}

function extractSprint(record) {
    return findRecordProp(record, [
        'Sprint', 'sprint', 'SPRINT', 'Sprints', 'Sprint Name'
    ]);
}

// ---- Chat helper: flexible time-range parser ----
function parseTimeRange(q) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start = null, end = null, label = '';

    // hôm nay
    if (q.includes('hom nay') || q.includes('today')) {
        start = new Date(today); end = new Date(today); end.setDate(end.getDate() + 1);
        label = 'hôm nay';
    }
    // hôm qua
    else if (q.includes('hom qua') || q.includes('yesterday')) {
        start = new Date(today); start.setDate(start.getDate() - 1);
        end = new Date(today);
        label = 'hôm qua';
    }
    // tuần này
    else if (q.includes('tuan nay') || q.includes('this week') || q.includes('trong tuan')) {
        const dow = today.getDay() || 7;
        start = new Date(today); start.setDate(start.getDate() - (dow - 1));
        end = new Date(start); end.setDate(end.getDate() + 7);
        label = 'tuần này';
    }
    // tuần trước
    else if (q.includes('tuan truoc') || q.includes('last week') || q.includes('tuan qua')) {
        const dow = today.getDay() || 7;
        start = new Date(today); start.setDate(start.getDate() - (dow - 1) - 7);
        end = new Date(start); end.setDate(end.getDate() + 7);
        label = 'tuần trước';
    }
    // tháng này (check BEFORE specific month regex)
    else if (q.includes('thang nay') || q.includes('this month') || q.includes('trong thang')) {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        label = 'tháng này';
    }
    // tháng trước (check BEFORE specific month regex)
    else if (q.includes('thang truoc') || q.includes('last month') || q.includes('thang qua')) {
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end = new Date(now.getFullYear(), now.getMonth(), 1);
        label = 'tháng trước';
    }
    // tháng cụ thể kèm năm: tháng 12/2025, tháng 1/2026
    else if (/thang\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/.test(q)) {
        const match = q.match(/thang\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/);
        const m = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);
        if (m >= 1 && m <= 12 && y >= 2020 && y <= 2099) {
            start = new Date(y, m - 1, 1);
            end = new Date(y, m, 1);
            label = `tháng ${m}/${y}`;
        }
    }
    // tháng cụ thể không có năm: tháng 1..12 (dùng năm hiện tại)
    else if (/thang\s*(\d{1,2})(?!\s*[\/.\-]\s*\d)/.test(q)) {
        const m = parseInt(q.match(/thang\s*(\d{1,2})/)[1], 10);
        if (m >= 1 && m <= 12) {
            // If month > current month, assume previous year
            const y = m > (now.getMonth() + 1) ? now.getFullYear() - 1 : now.getFullYear();
            start = new Date(y, m - 1, 1);
            end = new Date(y, m, 1);
            label = `tháng ${m}/${y}`;
        }
    }
    // N ngày gần đây / qua
    else if (/(\d+)\s*ngay\s*(gan|qua|truoc|gan day|gan nhat)/.test(q)) {
        const days = parseInt(q.match(/(\d+)\s*ngay/)[1], 10);
        start = new Date(today); start.setDate(start.getDate() - days);
        end = new Date(today); end.setDate(end.getDate() + 1);
        label = `${days} ngày qua`;
    }

    return { start, end, label };
}

function isDateInRange(dateStr, start, end) {
    if (!dateStr || !start || !end) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    return d >= start && d < end;
}

// ---- Chat helper: extract person name from query ----
function extractPersonFromQuery(q, rows) {
    const allNames = new Set();
    rows.forEach(row => {
        extractAssigneeNames(row).forEach(n => allNames.add(n));
    });
    const qLower = q;
    let bestMatch = '';
    let bestLen = 0;

    // 1. Exact full-name match (longest wins)
    for (const name of allNames) {
        const nNorm = normalizeQuery(name);
        if (qLower.includes(nNorm) && nNorm.length > bestLen) {
            bestMatch = name;
            bestLen = nNorm.length;
        }
    }
    if (bestMatch) return bestMatch;

    // 2. Partial match: any single word of name (≥2 chars) appears in query
    //    Prefer longer word matches, then disambiguate by checking both parts
    //    Skip Vietnamese stopwords that collide with names (only VERY common grammar words)
    const vnStopwords = new Set([
        'nhung',  // những (those) - collides with Nhung
        'cua',    // của (of)
        'duoc',   // được (can/able)
        'khong',  // không (not)
        'nhieu',  // nhiều (many)
        'truoc',  // trước (before)
        'sau',    // sau (after)
        'them',   // thêm (more)
        'toan',   // toàn (all)
        'thi',    // thì (then)
        'cho',    // cho (for/give)
        'khi',    // khi (when)
        'moi',    // mới (new) / mỗi (each)
        'qua',    // qua (past/over)
        'ngoai',  // ngoài (outside)
        'duoi',   // dưới (below)
        'tren',   // trên (above)
        'theo',   // theo (follow/according)
        'voi',    // với (with)
        'nao',    // nào (which)
        'biet',   // biết (know)
        'the',    // thế (so)
        'chay',   // chạy (run)
    ]);
    const candidates = [];
    for (const name of allNames) {
        const nNorm = normalizeQuery(name);
        const parts = nNorm.split(/\s+/).filter(p => p.length >= 2);
        for (const part of parts) {
            // Skip if this name-part is a common Vietnamese word
            if (vnStopwords.has(part)) continue;
            // Match as whole word in query using word boundary check
            const regex = new RegExp(`(^|\\s)${part.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}($|\\s)`);
            if (regex.test(qLower)) {
                candidates.push({ name, matchLen: part.length, part });
            }
        }
    }
    if (candidates.length === 1) return candidates[0].name;
    if (candidates.length > 1) {
        // Pick longest matched part (most specific)
        candidates.sort((a, b) => b.matchLen - a.matchLen);
        return candidates[0].name;
    }
    return bestMatch;
}

// ---- Chat helper: format number ----
function fmtNum(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function buildSmartCacheReply(userMessage, context, db) {
    const q = expandSynonyms(normalizeQuery(userMessage));
    if (!q) return null;

    const selectedFromContext = Array.isArray(context?.selected_database_ids) ? context.selected_database_ids : [];
    const selectedFromConfig = Array.isArray(db.getConfig('selected_databases')) ? db.getConfig('selected_databases') : [];
    const selectedIds = selectedFromContext.length > 0 ? selectedFromContext : selectedFromConfig;
    if (selectedIds.length === 0) return null;

    const rows = [];
    const dbNameMap = new Map();
    selectedIds.forEach(dbId => {
        const data = db.getData(dbId);
        if (Array.isArray(data) && data.length > 0) {
            const first = data[0];
            const dbName = first?.database_name || first?.project_name || dbId;
            dbNameMap.set(dbId, dbName);
            rows.push(...data);
        } else {
            dbNameMap.set(dbId, dbId);
        }
    });
    if (rows.length === 0) return null;


    const askTopAssignee =
        ((q.includes('ai') && q.includes('nhieu') && q.includes('task')) ||
            q.includes('top assignee') || q.includes('top nguoi')) &&
        !q.includes('qua han') && !q.includes('tre han') && !q.includes('overdue');
    const askTotalTask = (q.includes('bao nhieu task') || q.includes('tong task') || q.includes('so task')) &&
        !q.includes('confirm') && !q.includes('xac nhan');
    const askSyncTime = q.includes('sync luc nao') || q.includes('last sync') || q.includes('dong bo luc nao');
    const timeRange = parseTimeRange(q);
    const personInQuery = extractPersonFromQuery(q, rows);

    // Filter rows by time range if specified
    const filteredByTime = (timeRange.start && timeRange.end)
        ? rows.filter(r => {
            const d = extractCreatedDate(r) || extractDeadline(r);
            return isDateInRange(d, timeRange.start, timeRange.end);
        })
        : rows;
    const timeLabel = timeRange.label ? ` (${timeRange.label})` : '';

    // --- 1. Ai làm bao nhiêu task / Task / điểm / point của [tên] ---
    if (personInQuery && (q.includes('task') || q.includes('lam') || q.includes('danh sach') || q.includes('may') || q.includes('bao nhieu') || q.includes('diem') || q.includes('point') || q.includes('taskpoint'))) {
        const personRows = filteredByTime.filter(r =>
            extractAssigneeNames(r).some(n => normalizeQuery(n) === normalizeQuery(personInQuery))
        );
        if (personRows.length === 0) {
            return `Không tìm thấy task nào của ${personInQuery}${timeLabel}.`;
        }
        // Count by status
        const byStatus = new Map();
        let totalPt = 0;
        personRows.forEach(r => {
            const s = extractStatus(r) || 'Không rõ';
            byStatus.set(s, (byStatus.get(s) || 0) + 1);
            totalPt += extractTaskPoint(r);
        });
        const statusList = [...byStatus.entries()].sort((a, b) => b[1] - a[1])
            .map(([s, c]) => `- ${s}: ${c}`).join('\n');
        return `${personInQuery} có ${personRows.length} task${timeLabel}.\n📊 Tổng point: ${fmtNum(totalPt)}\n\nTheo trạng thái:\n${statusList}`;
    }

    // --- 2. Top assignee (existing, enhanced with time) ---
    if (askTopAssignee) {
        const source = filteredByTime;
        const byAssignee = new Map();
        source.forEach(row => {
            const names = extractAssigneeNames(row);
            names.forEach(name => byAssignee.set(name, (byAssignee.get(name) || 0) + 1));
        });
        const top = [...byAssignee.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (top.length === 0) return `Không xác định được người phụ trách${timeLabel}.`;
        const leaderboard = top.map(([name, count], i) => `${i + 1}. ${name}: ${count} task`).join('\n');
        return `Người có nhiều task nhất${timeLabel}: ${top[0][0]} (${top[0][1]} task).\nTop 5:\n${leaderboard}`;
    }

    // --- 3. Tổng task / bao nhiêu task ---
    if (askTotalTask) {
        const source = filteredByTime;
        const byStatus = new Map();
        source.forEach(r => {
            const s = extractStatus(r) || 'Không rõ';
            byStatus.set(s, (byStatus.get(s) || 0) + 1);
        });
        const statusBreakdown = [...byStatus.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([s, c]) => `- ${s}: ${c}`)
            .join('\n');
        return `Tổng task${timeLabel}: ${source.length}.\nPhân bổ theo trạng thái:\n${statusBreakdown}`;
    }

    // --- 4. Task chưa hoàn thành ---
    if ((q.includes('chua') && (q.includes('hoan thanh') || q.includes('xong') || q.includes('done'))) ||
        q.includes('incomplete') || q.includes('not done') || q.includes('dang lam')) {
        const incomplete = filteredByTime.filter(r => {
            const s = normalizeQuery(extractStatus(r));
            return s && !s.includes('done') && !s.includes('hoan thanh') && !s.includes('complete');
        });
        const byAssignee = new Map();
        incomplete.forEach(r => {
            extractAssigneeNames(r).forEach(n => {
                byAssignee.set(n, (byAssignee.get(n) || 0) + 1);
            });
        });
        const top = [...byAssignee.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const list = top.map(([n, c], i) => `${i + 1}. ${n}: ${c} task`).join('\n');
        return `Tổng task chưa hoàn thành${timeLabel}: ${incomplete.length}.\n${list ? 'Theo người:\n' + list : ''}`;
    }

    // --- 5. Task quá hạn / overdue ---
    if (q.includes('qua han') || q.includes('tre han') || q.includes('overdue') || q.includes('delay') || q.includes('bi delay')) {
        const now = new Date();
        const overdue = filteredByTime.filter(r => {
            const dl = extractDeadline(r);
            if (!dl) return false;
            const dd = new Date(dl);
            if (isNaN(dd.getTime())) return false;
            const s = normalizeQuery(extractStatus(r));
            return dd < now && s && !s.includes('done') && !s.includes('hoan thanh') && !s.includes('complete');
        });
        if (overdue.length === 0) return `Không có task quá hạn nào${timeLabel}. 🎉`;
        const byPerson = new Map();
        overdue.forEach(r => {
            extractAssigneeNames(r).forEach(n => byPerson.set(n, (byPerson.get(n) || 0) + 1));
        });
        const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const personList = top.map(([n, c], i) => `${i + 1}. ${n}: ${c} task quá hạn`).join('\n');
        return `Có ${overdue.length} task quá hạn${timeLabel}.\nNgười có nhiều task quá hạn nhất:\n${personList}`;
    }

    // --- 6. Task sắp deadline / deadline gần ---
    if (q.includes('sap') && (q.includes('deadline') || q.includes('han') || q.includes('het han'))) {
        const days = /(\d+)\s*ngay/.test(q) ? parseInt(q.match(/(\d+)\s*ngay/)[1], 10) : 3;
        const now = new Date();
        const future = new Date(now); future.setDate(future.getDate() + days);
        const upcoming = rows.filter(r => {
            const dl = extractDeadline(r);
            if (!dl) return false;
            const dd = new Date(dl);
            if (isNaN(dd.getTime())) return false;
            const s = normalizeQuery(extractStatus(r));
            return dd >= now && dd <= future && (!s || (!s.includes('done') && !s.includes('hoan thanh')));
        });
        if (upcoming.length === 0) return `Không có task nào sắp đến deadline trong ${days} ngày tới.`;
        const list = upcoming.slice(0, 10).map((r, i) => {
            const name = extractTaskName(r) || '(không tên)';
            const dl = extractDeadline(r);
            const assignee = extractAssigneeName(r) || '?';
            return `${i + 1}. ${name} — ${assignee} (hạn: ${dl})`;
        }).join('\n');
        return `Có ${upcoming.length} task sắp đến deadline trong ${days} ngày tới:\n${list}`;
    }

    // --- 7. Tổng workload / point từng member ---
    if ((q.includes('workload') || q.includes('point') || q.includes('diem')) &&
        (q.includes('tung') || q.includes('member') || q.includes('moi nguoi') || q.includes('thanh vien'))) {
        const source = filteredByTime;
        const byPerson = new Map();
        source.forEach(r => {
            const pt = extractTaskPoint(r);
            extractAssigneeNames(r).forEach(n => {
                const cur = byPerson.get(n) || { tasks: 0, points: 0 };
                cur.tasks += 1;
                cur.points += pt;
                byPerson.set(n, cur);
            });
        });
        const sorted = [...byPerson.entries()].sort((a, b) => b[1].points - a[1].points);
        if (sorted.length === 0) return `Không có dữ liệu workload${timeLabel}.`;
        const list = sorted.map(([n, d], i) => `${i + 1}. ${n}: ${fmtNum(d.points)} point (${d.tasks} task)`).join('\n');
        return `Workload từng member${timeLabel}:\n${list}`;
    }

    // --- 8. Ai đang bị quá tải ---
    if (q.includes('qua tai') || q.includes('overload') || (q.includes('ai') && q.includes('nhieu') && q.includes('point'))) {
        const byPerson = new Map();
        filteredByTime.forEach(r => {
            const pt = extractTaskPoint(r);
            extractAssigneeNames(r).forEach(n => {
                byPerson.set(n, (byPerson.get(n) || 0) + pt);
            });
        });
        const sorted = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return 'Không có dữ liệu để đánh giá quá tải.';
        const avg = sorted.reduce((s, [, p]) => s + p, 0) / sorted.length;
        const overloaded = sorted.filter(([, p]) => p > avg * 1.2);
        if (overloaded.length === 0) return `Không ai bị quá tải${timeLabel}. Trung bình: ${fmtNum(avg)} point/người.`;
        const list = overloaded.map(([n, p], i) => `${i + 1}. ${n}: ${fmtNum(p)} point (trung bình: ${fmtNum(avg)})`).join('\n');
        return `Có ${overloaded.length} người vượt >120% trung bình${timeLabel}:\n${list}`;
    }

    // --- 9. Task In Progress quá lâu ---
    if ((q.includes('in progress') || q.includes('dang lam') || q.includes('dang thuc hien')) &&
        (q.includes('qua') || q.includes('lau') || q.includes('ngay'))) {
        const days = /(\d+)\s*ngay/.test(q) ? parseInt(q.match(/(\d+)\s*ngay/)[1], 10) : 5;
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
        const stuck = rows.filter(r => {
            const s = normalizeQuery(extractStatus(r));
            if (!s.includes('in progress') && !s.includes('dang')) return false;
            const created = extractCreatedDate(r);
            if (!created) return false;
            const cd = new Date(created);
            return !isNaN(cd.getTime()) && cd < cutoff;
        });
        if (stuck.length === 0) return `Không có task In Progress nào quá ${days} ngày.`;
        const list = stuck.slice(0, 10).map((r, i) => {
            const name = extractTaskName(r) || '(không tên)';
            const assignee = extractAssigneeName(r) || '?';
            return `${i + 1}. ${name} — ${assignee}`;
        }).join('\n');
        return `Có ${stuck.length} task In Progress quá ${days} ngày:\n${list}`;
    }

    // --- 10. Tỷ lệ hoàn thành / OKR ---
    if (q.includes('ty le') || q.includes('hoan thanh') || q.includes('okr') || q.includes('completion')) {
        const source = filteredByTime;
        const isDoneStatus = (s) => {
            const n = normalizeQuery(s);
            return n && (n.includes('done') || n.includes('hoan thanh') || n.includes('complete'));
        };

        // Per-person breakdown when asking about "người" / "ai"
        const askPerPerson = q.includes('nguoi') || q.includes('ai') || q.includes('member') || q.includes('tung') || q.includes('cao nhat') || q.includes('thap nhat');
        if (askPerPerson) {
            const byPerson = new Map();
            source.forEach(r => {
                extractAssigneeNames(r).forEach(name => {
                    if (!byPerson.has(name)) byPerson.set(name, { done: 0, total: 0 });
                    const entry = byPerson.get(name);
                    entry.total++;
                    if (isDoneStatus(extractStatus(r))) entry.done++;
                });
            });
            // Filter to people with at least 5 tasks for meaningful rates
            const sorted = [...byPerson.entries()]
                .filter(([, d]) => d.total >= 5)
                .map(([name, d]) => ({ name, done: d.done, total: d.total, pct: (d.done / d.total * 100) }))
                .sort((a, b) => q.includes('thap') ? a.pct - b.pct : b.pct - a.pct)
                .slice(0, 10);
            if (sorted.length === 0) return `Không có dữ liệu tỷ lệ hoàn thành theo người${timeLabel}.`;
            const list = sorted.map((d, i) => `${i + 1}. ${d.name}: ${d.pct.toFixed(1)}% (${d.done}/${d.total} task)`).join('\n');
            const direction = q.includes('thap') ? 'thấp nhất' : 'cao nhất';
            return `Tỷ lệ hoàn thành ${direction}${timeLabel}:\n${list}`;
        }

        // Overall team rate
        const done = source.filter(r => isDoneStatus(extractStatus(r)));
        const pct = source.length > 0 ? ((done.length / source.length) * 100).toFixed(1) : 0;
        return `Tỷ lệ hoàn thành${timeLabel}: ${done.length}/${source.length} task (${pct}%).`;
    }

    // --- 11. Năng suất cao nhất ---
    if ((q.includes('nang suat') || q.includes('productivity')) &&
        (q.includes('cao nhat') || q.includes('top') || q.includes('best') || q.includes('nhat') || q.includes('ai') || q.includes('nguoi'))) {
        const source = filteredByTime;
        const byPerson = new Map();
        source.forEach(r => {
            const pt = extractTaskPoint(r);
            if (pt <= 0) return;
            extractAssigneeNames(r).forEach(n => {
                byPerson.set(n, (byPerson.get(n) || 0) + pt);
            });
        });
        const sorted = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (sorted.length === 0) return `Không có dữ liệu năng suất${timeLabel}.`;
        const list = sorted.map(([n, p], i) => `${i + 1}. ${n}: ${fmtNum(p)} point`).join('\n');
        return `Năng suất cao nhất${timeLabel}:\n${list}`;
    }

    // --- 12. So sánh confirmed vs unconfirmed ---
    if ((q.includes('confirmed') && q.includes('unconfirmed')) || (q.includes('so sanh') && (q.includes('confirm') || q.includes('xac nhan')))) {
        const source = filteredByTime;
        const byPerson = new Map();
        source.forEach(r => {
            const ps = extractPointStatus(r);
            const pt = extractTaskPoint(r);
            extractAssigneeNames(r).forEach(n => {
                const cur = byPerson.get(n) || { confirmed: 0, unconfirmed: 0 };
                if (ps.includes('confirm') && !ps.includes('un')) cur.confirmed += pt;
                else cur.unconfirmed += pt;
                byPerson.set(n, cur);
            });
        });
        const list = [...byPerson.entries()]
            .sort((a, b) => (b[1].confirmed + b[1].unconfirmed) - (a[1].confirmed + a[1].unconfirmed))
            .slice(0, 10)
            .map(([n, d], i) => `${i + 1}. ${n}: ✅ ${fmtNum(d.confirmed)} | ⏳ ${fmtNum(d.unconfirmed)}`)
            .join('\n');
        return `So sánh Confirmed vs Unconfirmed${timeLabel}:\n(✅ Confirmed | ⏳ Unconfirmed)\n${list || 'Không có dữ liệu.'}`;
    }

    // --- 13. Task chưa assign ---
    if ((q.includes('chua') || q.includes('khong co')) && (q.includes('assign') || q.includes('phu trach') || q.includes('nguoi'))) {
        const unassigned = filteredByTime.filter(r => extractAssigneeNames(r).length === 0);
        if (unassigned.length === 0) return `Tất cả task đều đã được assign${timeLabel}. ✅`;
        const list = unassigned.slice(0, 10).map((r, i) => {
            const name = extractTaskName(r) || '(không tên)';
            const status = extractStatus(r) || '?';
            return `${i + 1}. ${name} [${status}]`;
        }).join('\n');
        const extra = unassigned.length > 10 ? `\n...và ${unassigned.length - 10} task khác.` : '';
        return `Có ${unassigned.length} task chưa assign${timeLabel}:\n${list}${extra}`;
    }

    // --- 14. Task effort lớn / Ranking effort ---
    if (q.includes('effort') && (q.includes('lon') || q.includes('cao') || />\s*\d/.test(q) || q.includes('ton'))) {
        const hasThreshold = />\s*\d/.test(q) || /(\d+)\s*(ngay|day)/.test(q);
        const askTop = q.includes('nhat') || q.includes('top') || q.includes('cao nhat');
        const askPerson = q.includes('ai') || q.includes('nguoi') || q.includes('member') || q.includes('nhan su');

        if (askPerson) {
            // Ranking by person: "Ai tốn nhiều effort nhất?"
            const byPerson = new Map();
            filteredByTime.forEach(r => {
                const eff = extractEffort(r);
                if (eff <= 0) return;
                extractAssigneeNames(r).forEach(n => {
                    const cur = byPerson.get(n) || { effort: 0, tasks: 0 };
                    cur.effort += eff; cur.tasks++;
                    byPerson.set(n, cur);
                });
            });
            const sorted = [...byPerson.entries()].sort((a, b) => b[1].effort - a[1].effort);
            if (sorted.length === 0) return `Không có dữ liệu effort theo nhân sự${timeLabel}.`;

            if (askTop || q.includes('nhat')) {
                const [topName, topData] = sorted[0];
                const otherList = sorted.slice(1, 6).map(([n, d], i) => `${i + 2}. ${n}: ${fmtNum(d.effort)} ngày`).join('\n');
                return `Người tốn nhiều effort nhất${timeLabel} là **${topName}** (${fmtNum(topData.effort)} ngày công, ${topData.tasks} task).\n\nTop 5 khác:\n${otherList}`;
            }
            const list = sorted.slice(0, 10).map(([n, d], i) => `${i + 1}. ${n}: ${fmtNum(d.effort)} ngày (${d.tasks} task)`).join('\n');
            return `Xếp hạng nhân sự theo effort${timeLabel}:\n${list}`;
        }

        if (hasThreshold && !askTop) {
            // Threshold filter: "task effort > 3 ngày"
            const threshold = /(\d+)/.test(q) ? parseInt(q.match(/(\d+)/)[1], 10) : 3;
            const bigTasks = filteredByTime.filter(r => extractEffort(r) > threshold)
                .sort((a, b) => extractEffort(b) - extractEffort(a));
            if (bigTasks.length === 0) return `Không có task nào có effort > ${threshold} ngày công${timeLabel}.`;
            const list = bigTasks.slice(0, 10).map((r, i) => {
                const name = extractTaskName(r) || '(không tên)';
                const eff = extractEffort(r);
                const assignee = extractAssigneeName(r) || '?';
                return `${i + 1}. ${name} (${fmtNum(eff)} ngày) — ${assignee}`;
            }).join('\n');
            const total = bigTasks.length;
            const extra = total > 10 ? `\n...và ${total - 10} task khác.` : '';
            return `Lọc ${total} task có effort > ${threshold} ngày công${timeLabel}:\n${list}${extra}`;
        } else {
            // Task ranking: "task tốn nhiều thời gian nhất"
            const sorted = filteredByTime
                .filter(r => extractEffort(r) > 0)
                .sort((a, b) => extractEffort(b) - extractEffort(a));
            if (sorted.length === 0) return `Không có dữ liệu effort${timeLabel}.`;

            if (askTop || q.includes('nhat')) {
                const r = sorted[0];
                const name = extractTaskName(r) || '(không tên)';
                const eff = extractEffort(r);
                const assignee = extractAssigneeName(r) || '?';
                const pj = extractTaskProjectName(r) || '?';
                const otherList = sorted.slice(1, 6).map((r2, i) => `${i + 2}. ${extractTaskName(r2)} (${fmtNum(extractEffort(r2))} ngày)`).join('\n');
                return `Task tốn nhiều thời gian nhất${timeLabel} là **${name}** (${fmtNum(eff)} ngày công) của **${assignee}** [Dự án: ${pj}].\n\nTop 5 khác:\n${otherList}`;
            }
            const list = sorted.slice(0, 10).map((r, i) => `${i + 1}. ${extractTaskName(r)} (${fmtNum(extractEffort(r))} ngày) — ${extractAssigneeName(r)}`).join('\n');
            return `Top task tốn effort nhiều nhất${timeLabel}:\n${list}`;
        }
    }

    // --- 15. Task type Bug ---
    if (q.includes('bug') || (q.includes('loai') && q.includes('task')) || q.includes('task type') || q.includes('report type')) {
        const typeKeyword = q.includes('bug') ? 'bug' : '';
        const source = filteredByTime;
        if (typeKeyword) {
            const bugs = source.filter(r => normalizeQuery(extractTaskType(r)).includes(typeKeyword));
            if (bugs.length === 0) return `Không có task loại Bug${timeLabel}.`;
            const list = bugs.slice(0, 10).map((r, i) => {
                const name = extractTaskName(r) || '(không tên)';
                const assignee = extractAssigneeName(r) || '?';
                return `${i + 1}. ${name} — ${assignee}`;
            }).join('\n');
            return `Có ${bugs.length} task loại Bug${timeLabel}:\n${list}`;
        }
        // General type breakdown
        const byType = new Map();
        source.forEach(r => {
            const t = extractTaskType(r) || 'Không rõ';
            byType.set(t, (byType.get(t) || 0) + 1);
        });
        const list = [...byType.entries()].sort((a, b) => b[1] - a[1])
            .map(([t, c]) => `- ${t}: ${c}`).join('\n');
        return `Phân bổ theo loại task${timeLabel}:\n${list}`;
    }

    // --- 16. Dự án tốn effort nhất ---
    if ((q.includes('du an') || q.includes('project')) && (q.includes('effort') || q.includes('ton') || q.includes('nhieu nhat'))) {
        const byProject = new Map();
        filteredByTime.forEach(r => {
            const pj = extractTaskProjectName(r) || 'Không rõ';
            const eff = extractEffort(r);
            const cur = byProject.get(pj) || { effort: 0, tasks: 0 };
            cur.effort += eff; cur.tasks += 1;
            byProject.set(pj, cur);
        });
        const sorted = [...byProject.entries()].sort((a, b) => b[1].effort - a[1].effort).slice(0, 10);
        if (sorted.length === 0) return `Không có dữ liệu effort theo dự án${timeLabel}.`;
        const list = sorted.map(([p, d], i) => `${i + 1}. ${p}: ${fmtNum(d.effort)} ngày công (${d.tasks} task)`).join('\n');
        return `Dự án tốn effort nhất${timeLabel}:\n${list}`;
    }

    // --- 16b. So sánh workload theo dự án ---
    if (q.includes('so sanh workload du an') || ((q.includes('so sanh') || q.includes('workload')) && q.includes('du an'))) {
        const byProject = new Map();
        filteredByTime.forEach(r => {
            const pj = extractTaskProjectName(r) || '(Không rõ)';
            const pt = extractTaskPoint(r);
            const eff = extractEffort(r);
            const cur = byProject.get(pj) || { tasks: 0, points: 0, effort: 0 };
            cur.tasks += 1; cur.points += pt; cur.effort += eff;
            byProject.set(pj, cur);
        });
        const sorted = [...byProject.entries()].sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 15);
        if (sorted.length === 0) return `Không có dữ liệu workload theo dự án${timeLabel}.`;
        const list = sorted.map(([p, d], i) => `${i + 1}. ${p}: ${d.tasks} task | ${fmtNum(d.points)} pt | ${fmtNum(d.effort)} ngày`).join('\n');
        return `📊 Workload theo dự án${timeLabel}:\n(Thứ tự: Task | Point | Effort)\n${list}`;
    }

    // --- 16c. Tổng point thực tế ---
    if (q.includes('tong point thuc te') || (q.includes('tong') && q.includes('point') && !q.includes('tung') && !q.includes('member'))) {
        const source = filteredByTime;
        let totalPt = 0;
        const byPerson = new Map();
        source.forEach(r => {
            const pt = extractTaskPoint(r);
            totalPt += pt;
            extractAssigneeNames(r).forEach(n => {
                byPerson.set(n, (byPerson.get(n) || 0) + pt);
            });
        });
        const sorted = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const list = sorted.map(([n, p], i) => `${i + 1}. ${n}: ${fmtNum(p)} pt`).join('\n');
        return `🎯 Tổng point thực tế${timeLabel}: ${fmtNum(totalPt)} point (${source.length} task)\n\nTop 10 người:\n${list}`;
    }

    // --- 17. Tổng point lệch % ---
    if (q.includes('lech') || (q.includes('thuc te') && q.includes('yeu cau')) || q.includes('gap')) {
        let totalReq = 0, totalActual = 0;
        filteredByTime.forEach(r => {
            const req = parseFloat(findRecordProp(r, ['Task point yêu cầu dự án', 'Task point', 'task_point', 'Point Required'])) || 0;
            const actual = extractTaskPoint(r);
            totalReq += req; totalActual += actual;
        });
        if (totalReq === 0 && totalActual === 0) return 'Không có dữ liệu point yêu cầu / thực tế.';
        const diff = totalReq > 0 ? (((totalActual - totalReq) / totalReq) * 100).toFixed(1) : 'N/A';
        return `Tổng point${timeLabel}:\n- Yêu cầu: ${fmtNum(totalReq)}\n- Thực tế: ${fmtNum(totalActual)}\n- Chênh lệch: ${diff}%`;
    }

    // --- 18. Xu hướng workload 4 tuần ---
    if (q.includes('xu huong') || q.includes('trend') || (q.includes('4') && q.includes('tuan'))) {
        const now = new Date();
        const weeks = [];
        for (let w = 3; w >= 0; w--) {
            const wStart = new Date(now); wStart.setDate(wStart.getDate() - (w * 7 + (now.getDay() || 7) - 1));
            wStart.setHours(0, 0, 0, 0);
            const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
            const count = rows.filter(r => {
                const d = extractCreatedDate(r);
                return isDateInRange(d, wStart, wEnd);
            }).length;
            const label2 = `${wStart.getDate()}/${wStart.getMonth() + 1}`;
            weeks.push({ label: label2, count });
        }
        const trend = weeks[3].count >= weeks[0].count ? '📈 Tăng' : '📉 Giảm';
        const weekLines = weeks.map((w, i) => `Tuần ${i + 1} (${w.label}): ${w.count} task`).join('\n');
        return `Xu hướng workload 4 tuần gần nhất: ${trend}\n${weekLines}`;
    }

    // --- 19. Sprint info ---
    if (q.includes('sprint')) {
        const bySprint = new Map();
        filteredByTime.forEach(r => {
            const sp = extractSprint(r) || 'Không rõ';
            const cur = bySprint.get(sp) || { total: 0, done: 0, points: 0 };
            cur.total += 1;
            const s = normalizeQuery(extractStatus(r));
            if (s.includes('done') || s.includes('hoan thanh')) cur.done += 1;
            cur.points += extractTaskPoint(r);
            bySprint.set(sp, cur);
        });
        const list = [...bySprint.entries()]
            .filter(([s]) => s !== 'Không rõ')
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 8)
            .map(([s, d]) => `- ${s}: ${d.done}/${d.total} task hoàn thành (${fmtNum(d.points)} point)`)
            .join('\n');
        return `Thống kê Sprint${timeLabel}:\n${list || 'Không có dữ liệu Sprint.'}`;
    }

    // --- 20. Sync time (existing, kept) ---
    if (askSyncTime) {
        const syncLines = selectedIds.slice(0, 5).map(dbId => {
            const syncAt = db.getLastSyncTime(dbId) || db.getLastUpdate() || 'không rõ';
            const dbName = dbNameMap.get(dbId) || dbId;
            return `- ${dbName}: ${syncAt}`;
        });
        return `Thời gian đồng bộ gần nhất (tối đa 5 database):\n${syncLines.join('\n')}`;
    }

    // --- 21. Status breakdown / thống kê ---
    if (q.includes('thong ke') || q.includes('thống kê') || q.includes('summary') || q.includes('tong quan') || q.includes('overview')) {
        const source = filteredByTime;
        const byStatus = new Map();
        let totalPt = 0;
        source.forEach(r => {
            const s = extractStatus(r) || 'Không rõ';
            byStatus.set(s, (byStatus.get(s) || 0) + 1);
            totalPt += extractTaskPoint(r);
        });
        const statusList = [...byStatus.entries()].sort((a, b) => b[1] - a[1])
            .map(([s, c]) => `- ${s}: ${c}`).join('\n');
        const assigneeCount = new Set();
        source.forEach(r => extractAssigneeNames(r).forEach(n => assigneeCount.add(n)));
        return `Tổng quan${timeLabel}:\n📊 Tổng task: ${source.length}\n👥 Thành viên: ${assigneeCount.size}\n🎯 Tổng point: ${fmtNum(totalPt)}\n\nTheo trạng thái:\n${statusList}`;
    }

    // --- 22. Confirmed / Unconfirmed point riêng lẻ ---
    if ((q.includes('confirm') || q.includes('xac nhan')) && !q.includes('so sanh')) {
        const isUnconfirm = q.includes('unconfirm') || q.includes('chua xac nhan') || q.includes('chua confirm');
        const askPerson = q.includes('ai') || q.includes('nguoi') || q.includes('member');
        const source = filteredByTime;
        let totalCount = 0, totalPt = 0;
        const byPerson = new Map();

        source.forEach(r => {
            const ps = extractPointStatus(r);
            const pt = extractTaskPoint(r);
            let matches = false;
            if (isUnconfirm) {
                if (ps.includes('un') || !ps.includes('confirm')) matches = true;
            } else {
                if (ps.includes('confirm') && !ps.includes('un')) matches = true;
            }

            if (matches) {
                totalCount++; totalPt += pt;
                extractAssigneeNames(r).forEach(n => {
                    const cur = byPerson.get(n) || { count: 0, pt: 0 };
                    cur.count++; cur.pt += pt;
                    byPerson.set(n, cur);
                });
            }
        });

        const label = isUnconfirm ? 'Unconfirmed' : 'Confirmed';
        const sorted = [...byPerson.entries()].sort((a, b) => b[1].pt - a[1].pt);
        if (sorted.length === 0) return `Task ${label}${timeLabel}: ${totalCount} task, tổng ${fmtNum(totalPt)} point.`;

        if (askPerson || q.includes('nhat')) {
            const [topName, topData] = sorted[0];
            const otherList = sorted.slice(1, 6).map(([n, d], i) => `${i + 2}. ${n}: ${fmtNum(d.pt)} pt`).join('\n');
            return `Người có nhiều point ${label}${timeLabel} nhất là **${topName}** với **${fmtNum(topData.pt)} point** (${topData.count} task).\n\nTop 5 khác:\n${otherList}`;
        }

        const list = sorted.slice(0, 10).map(([n, d], i) => `${i + 1}. ${n}: ${d.count} task (${fmtNum(d.pt)} point)`).join('\n');
        return `Task ${label}${timeLabel}: ${totalCount} task, tổng ${fmtNum(totalPt)} point.\n\nChi tiết theo nhân sự:\n${list}`;
    }

    // --- 23. Task theo status cụ thể ---
    if (q.includes('task') && (q.includes('in progress') || q.includes('not started') || q.includes('done qc') || q.includes('pending'))) {
        let statusKey = '';
        if (q.includes('in progress')) statusKey = 'in progress';
        else if (q.includes('not started')) statusKey = 'not started';
        else if (q.includes('done qc')) statusKey = 'done qc';
        else if (q.includes('pending')) statusKey = 'pending';
        const matched = filteredByTime.filter(r => normalizeQuery(extractStatus(r)).includes(statusKey));
        const byPerson = new Map();
        matched.forEach(r => {
            extractAssigneeNames(r).forEach(n => byPerson.set(n, (byPerson.get(n) || 0) + 1));
        });
        const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const list = top.map(([n, c], i) => `${i + 1}. ${n}: ${c} task`).join('\n');
        return `Có ${matched.length} task "${statusKey}"${timeLabel}.\n${list ? 'Theo người:\n' + list : ''}`;
    }

    // --- 24. Ai rảnh nhất / ít task nhất ---
    if ((q.includes('ranh') || q.includes('it task') || q.includes('it nhat') || q.includes('least')) &&
        (q.includes('ai') || q.includes('nguoi'))) {
        const byPerson = new Map();
        filteredByTime.forEach(r => {
            extractAssigneeNames(r).forEach(n => byPerson.set(n, (byPerson.get(n) || 0) + 1));
        });
        const sorted = [...byPerson.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5);
        if (sorted.length === 0) return 'Không có dữ liệu.';
        const list = sorted.map(([n, c], i) => `${i + 1}. ${n}: ${c} task`).join('\n');
        return `Người ít task nhất${timeLabel}:\n${list}`;
    }

    // --- 25. Tổng effort từng người ---
    if (q.includes('effort') && (q.includes('tung') || q.includes('member') || q.includes('moi nguoi') || q.includes('thanh vien'))) {
        const byPerson = new Map();
        filteredByTime.forEach(r => {
            const eff = extractEffort(r);
            extractAssigneeNames(r).forEach(n => {
                const cur = byPerson.get(n) || { effort: 0, tasks: 0 };
                cur.effort += eff; cur.tasks += 1;
                byPerson.set(n, cur);
            });
        });
        const sorted = [...byPerson.entries()].sort((a, b) => b[1].effort - a[1].effort);
        if (sorted.length === 0) return `Không có dữ liệu effort${timeLabel}.`;
        const list = sorted.map(([n, d], i) => `${i + 1}. ${n}: ${fmtNum(d.effort)} ngày công (${d.tasks} task)`).join('\n');
        return `Effort từng member${timeLabel}:\n${list}`;
    }

    // --- 26. Ai chưa có task ---
    if ((q.includes('ai') || q.includes('nguoi')) && q.includes('chua co task')) {
        const activeNames = new Set();
        filteredByTime.forEach(r => extractAssigneeNames(r).forEach(n => activeNames.add(n)));
        const allNames = new Set();
        rows.forEach(r => extractAssigneeNames(r).forEach(n => allNames.add(n)));
        const idle = [...allNames].filter(n => !activeNames.has(n));
        if (idle.length === 0) return `Tất cả thành viên đều có task${timeLabel}. ✅`;
        return `${idle.length} người chưa có task${timeLabel}:\n${idle.join(', ')}`;
    }

    // --- 27. Danh sách dự án / dự án đang chạy ---
    if (q.includes('du an') && (q.includes('dang chay') || q.includes('danh sach') || q.includes('list') || q.includes('co nhung') || q.includes('nhung') || q.includes('nao'))) {
        const byProject = new Map();
        rows.forEach(r => {
            const pj = r?.database_name || r?.project_name || extractTaskProjectName(r) || '(Không rõ)';
            byProject.set(pj, (byProject.get(pj) || 0) + 1);
        });
        const sorted = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
        const list = sorted.slice(0, 20).map(([p, c], i) => `${i + 1}. ${p}: ${c} task`).join('\n');
        const extra = sorted.length > 20 ? `\n...và ${sorted.length - 20} dự án khác` : '';
        return `📌 ${sorted.length} dự án đang có dữ liệu${timeLabel}:\n${list}${extra}`;
    }

    // --- 28. Tìm người / kiểm tra ai làm ở đâu ---
    if (personInQuery && (q.includes('du an nao') || q.includes('o dau') || q.includes('lam o') || q.includes('nhung du an') || q.includes('thuoc du an'))) {
        const personRows = filteredByTime.filter(r =>
            extractAssigneeNames(r).some(n => normalizeQuery(n) === normalizeQuery(personInQuery))
        );
        if (personRows.length === 0) return `Không tìm thấy task nào của ${personInQuery}${timeLabel}.`;
        const byProject = new Map();
        personRows.forEach(r => {
            const pj = r?.database_name || r?.project_name || extractTaskProjectName(r) || '?';
            byProject.set(pj, (byProject.get(pj) || 0) + 1);
        });
        const sorted = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
        const list = sorted.map(([p, c], i) => `${i + 1}. ${p}: ${c} task`).join('\n');
        return `${personInQuery} có ${personRows.length} task${timeLabel} ở ${sorted.length} dự án:\n${list}`;
    }

    return null;
}

// Wrapper that appends scope note
function buildSmartCacheReplyWithScope(userMessage, context, db) {
    const result = buildSmartCacheReply(userMessage, context, db);
    if (!result) return null;

    const selectedFromContext = Array.isArray(context?.selected_database_ids) ? context.selected_database_ids : [];
    const selectedFromConfig = Array.isArray(db.getConfig('selected_databases')) ? db.getConfig('selected_databases') : [];
    const usingAllCache = selectedFromContext.length === 0 && selectedFromConfig.length > 0;
    const selectedIds = selectedFromContext.length > 0 ? selectedFromContext : selectedFromConfig;

    // Collect project names
    const projectNames = new Set();
    selectedIds.forEach(dbId => {
        const data = db.getData(dbId);
        if (Array.isArray(data) && data.length > 0) {
            const first = data[0];
            const name = first?.database_name || first?.project_name || '';
            if (name) projectNames.add(name);
        }
    });

    if (usingAllCache) {
        return result + `\n\n💡 Đang dùng dữ liệu từ tất cả ${projectNames.size} dự án đã cache. Chọn dự án cụ thể ở sidebar để thu hẹp phạm vi.`;
    }

    // Show selected project names
    if (projectNames.size > 0) {
        const names = [...projectNames].slice(0, 5).join(', ');
        const extra = projectNames.size > 5 ? ` và ${projectNames.size - 5} dự án khác` : '';
        return result + `\n\n📌 Dự án: ${names}${extra}`;
    }

    return result;
}

// ---- AI Intent Classifier: rewrite natural language to canonical query ----
const INTENT_PATTERNS_DESC = [
    'ai có nhiều task nhất / top assignee',
    'bao nhiêu task / tổng task / số task',
    'task chưa hoàn thành / chưa xong / chưa done',
    'task quá hạn / trễ hạn / overdue / delay',
    'task sắp deadline N ngày',
    'workload point từng member / thành viên',
    'ai đang bị quá tải',
    'task in progress quá N ngày',
    'tỷ lệ hoàn thành / completion',
    'năng suất cao nhất / productivity',
    'so sánh confirmed vs unconfirmed',
    'task chưa assign / chưa có người phụ trách',
    'task effort lớn hơn N ngày',
    'task loại Bug / loại task / task type',
    'dự án nào tốn effort nhất',
    'tổng point thực tế so với yêu cầu / lệch',
    'xu hướng workload 4 tuần / trend',
    'thống kê sprint',
    'sync lúc nào / last sync',
    'tổng quan / thống kê / overview / summary',
    'số task confirmed / unconfirmed',
    'task in progress / not started / done qc / pending',
    'ai rảnh nhất / ít task nhất',
    'effort từng member / thành viên',
    'ai chưa có task',
    '[tên người] có bao nhiêu task / mấy task / điểm / point',
].join('\n- ');

async function classifyIntentWithAI(userMessage, apiKey, baseUrl) {
    if (!apiKey) return null;

    const prompt = `Bạn là bộ phân loại câu hỏi. Nhiệm vụ: viết lại câu hỏi của user thành dạng chuẩn mà hệ thống keyword-matching có thể hiểu.

Danh sách pattern hệ thống hỗ trợ:
- ${INTENT_PATTERNS_DESC}

Thời gian hỗ trợ: hôm nay, hôm qua, tuần này, tuần trước, tháng 1-12, tháng này, tháng trước, N ngày qua.

QUY TẮC:
1. Chỉ trả về DUY NHẤT câu query đã viết lại, không giải thích
2. Giữ nguyên tên người nếu có
3. Giữ nguyên thời gian nếu có
4. Nếu câu hỏi KHÔNG liên quan đến task/workload/project → trả về: NONE
5. Viết bằng tiếng Việt không dấu nếu cần

Ví dụ:
- "Ê tuần này ai làm được nhiều nhất?" → "ai có nhiều task nhất tuần này"
- "Cho xem điểm mấy đứa tháng rồi đi" → "workload point từng member tháng trước"
- "Thịnh làm được bao nhiêu rồi?" → "Thịnh có bao nhiêu task"
- "Tình hình chung tuần này thế nào?" → "tổng quan task tuần này"
- "Xin chào!" → "NONE"
- "Hôm nay trời đẹp quá" → "NONE"

Câu hỏi user: "${userMessage.replace(/"/g, '\\"')}"`;

    const provider = (process.env.AI_PROVIDER || '').toLowerCase();
    const isGemini = provider === 'gemini' || apiKey.startsWith('AIza');

    try {
        if (isGemini) {
            const geminiBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
            const model = 'gemini-2.0-flash';
            const url = `${geminiBaseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 100 }
                }),
                signal: AbortSignal.timeout(8000)
            });
            if (!response.ok) return null;
            const payload = await response.json();
            const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!text || text === 'NONE' || text.length > 200) return null;
            return text.replace(/^["']|["']$/g, '').trim();
        }

        // OpenAI-compatible (Ollama, LM Studio, etc.)
        const chatModel = process.env.AI_MODEL || 'qwen3:8b';
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: chatModel,
                temperature: 0,
                max_tokens: 150,
                messages: [
                    { role: 'user', content: prompt }
                ]
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) return null;
        const payload = await response.json();
        let text = payload?.choices?.[0]?.message?.content?.trim();
        if (!text || text === 'NONE' || text.length > 200) return null;
        // Strip <think>...</think> tags from reasoning models
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return text.replace(/^["']|["']$/g, '').trim();
    } catch {
        return null;
    }
}

// Fun fallback replies when AI is unavailable (quota, error, etc.)
const FUN_FALLBACKS = [
    'Ối, não AI hết pin rồi 🪫😅 Thử hỏi mấy câu này nha:\n• "Tổng quan task tuần này"\n• "Ai có nhiều task nhất?"\n• "Task quá hạn"',
    'AI đang nghỉ xả hơi chút 🧘 Nhưng mấy câu này thì mình trả lời ez:\n• "Workload point từng member"\n• "Task chưa hoàn thành"\n• "Ai rảnh nhất?"',
    'Hết quota AI rồi nè, chill chút nhé 😎 Mình vẫn trả lời được mấy câu về task:\n• "Tổng quan task"\n• "Ai có nhiều task nhất?"\n• "Task sắp deadline 3 ngày"',
    'Ê ê, AI quá tải rồi á 🤯 Đợi chút hoặc hỏi trực tiếp kiểu:\n• "Số task confirmed"\n• "Task In Progress"\n• "Xu hướng workload 4 tuần"',
    'AI lag real 😵‍💫 Thử lại sau hoặc hỏi cụ thể nha:\n• "Tổng quan task tháng này"\n• "Năng suất cao nhất tuần trước"\n• "Effort từng member"',
];

function getQuotaFallbackReply(userMessage) {
    const idx = Math.floor(Math.random() * FUN_FALLBACKS.length);
    return FUN_FALLBACKS[idx];
}

export function setupRoutes(app, db, poller) {
    const isValidNotionToken = (token) => {
        return typeof token === 'string'
            && token.trim().length >= 40
            && !/secret_xxx|replace_with|change-this/i.test(token);
    };

    const getStoredNotionToken = () => {
        const rawToken = process.env.NOTION_ACCESS_TOKEN || process.env.NOTION_TOKEN || db.getConfig('access_token') || null;
        return isValidNotionToken(rawToken) ? rawToken : null;
    };

    let notionToken = getStoredNotionToken();
    let globalProjectsService = null;

    const refreshNotionToken = () => {
        const token = getStoredNotionToken();
        if (token !== notionToken) {
            notionToken = token;
            globalProjectsService = null;
        }
        return notionToken;
    };

    const ensureNotionToken = () => {
        notionToken = getStoredNotionToken();
        return notionToken;
    };

    const getChatRuntimeConfig = () => {
        const chatApiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.AL_API_KEY || '';
        const chatProvider = (process.env.AI_PROVIDER || (chatApiKey.startsWith('AIza') ? 'gemini' : 'openai')).toLowerCase();
        const defaultBase = chatProvider === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta'
            : 'https://api.openai.com/v1';
        return {
            chatbotEnabled: process.env.CHATBOT_ENABLED !== 'false',
            chatApiKey,
            chatProvider,
            chatBaseUrl: (process.env.AI_BASE_URL || defaultBase).replace(/\/$/, ''),
            chatModel: process.env.AI_MODEL || (chatProvider === 'gemini' ? 'gemini-1.5-flash' : 'gpt-4o-mini')
        };
    };
    const rawWarmupInFlight = new Set();
    const syncJobsPath = path.join(__dirname, '..', '..', 'data', 'sync_jobs.json');
    const syncJobs = loadSyncJobs(syncJobsPath);
    const saveSyncJobs = () => persistSyncJobs(syncJobsPath, syncJobs);
    const relationNameCache = new Map(Object.entries(db.getMetadata('relation_name_cache') || {}));
    const persistRelationNameCache = () => {
        const toSave = {};
        relationNameCache.forEach((value, key) => {
            toSave[key] = value;
        });
        db.setMetadata('relation_name_cache', toSave);
    };

    const getProjectsService = () => {
        const token = refreshNotionToken();
        if (!token) return null;
        if (!globalProjectsService) {
            globalProjectsService = new ProjectsService(token);
        }
        return globalProjectsService;
    };

    // Helper: Get databases with cache
    const getCachedDatabases = async () => {
        const now = Date.now();
        if (databasesCache && (now - databasesCacheTime) < CACHE_TTL) {
            return databasesCache;
        }
        const token = ensureNotionToken();
        if (!token) throw new Error('No Notion token configured');
        const discovery = new DatabaseDiscovery(token);
        databasesCache = await discovery.discoverDatabases();
        databasesCacheTime = now;
        console.log(`[Cache] Refreshed databases cache: ${databasesCache.length} databases`);
        return databasesCache;
    };

    const scheduleBackgroundCacheWarmup = (reason = 'manual') => {
        if (!poller || typeof poller.triggerPoll !== 'function') {
            return false;
        }

        setTimeout(async () => {
            try {
                console.log(`[API] Background cache warmup started (${reason})`);
                await poller.triggerPoll();
                db.buildLookupCache();
                console.log(`[API] Background cache warmup completed (${reason})`);
            } catch (error) {
                console.warn(`[API] Background cache warmup failed (${reason}):`, error.message);
            }
        }, 50);

        return true;
    };

    const scheduleRawDatabaseWarmup = (databaseId, reason = 'raw_checkpoint_due') => {
        if (!databaseId || rawWarmupInFlight.has(databaseId)) {
            return false;
        }
        const token = ensureNotionToken();
        if (!token) {
            return false;
        }

        rawWarmupInFlight.add(databaseId);
        setTimeout(async () => {
            try {
                console.log(`[API] Background raw warmup started for ${databaseId} (${reason})`);
                const fetcher = new DataFetcher(notionToken, db);
                const result = await fetcher.fetchAllData([databaseId], null, {
                    fullSync: true,
                    fullSyncCheckpointMs: FULL_SYNC_CHECKPOINT_MS,
                    failOnDatabaseError: true
                });
                const rows = Array.isArray(result?.[databaseId]) ? result[databaseId] : null;
                if (rows) {
                    db.saveData(databaseId, rows);
                    rawFormatCache.clear();
                    console.log(`[API] Background raw warmup completed for ${databaseId}: ${rows.length} rows`);
                }
            } catch (error) {
                console.warn(`[API] Background raw warmup failed for ${databaseId}:`, error.message);
            } finally {
                rawWarmupInFlight.delete(databaseId);
            }
        }, 30);

        return true;
    };

    // ============ AUTH ROUTES ============
    app.get('/auth/status', (req, res) => {
        const token = ensureNotionToken();
        const configured = !!token;
        const sessionAuthenticated = !!req.session?.configured;
        res.json({
            authenticated: configured, // Backward compatible for current UI
            configured,
            session_authenticated: sessionAuthenticated,
            auth_state: {
                token_configured: configured,
                session_authenticated: sessionAuthenticated
            },
            isAdmin: process.env.ADMIN_MODE === 'true' // Admin mode check
        });
    });

    app.post('/auth/setup', (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });
        req.session.configured = true;
        res.json({ success: true, session_authenticated: true });
    });

    app.post('/auth/logout', (req, res) => {
        req.session.destroy();
        res.json({ success: true });
    });

    // ============ CHATBOT ROUTES ============
    app.get('/api/chat/config', (req, res) => {
        const { chatbotEnabled, chatProvider, chatModel, chatApiKey } = getChatRuntimeConfig();
        res.json({
            success: true,
            enabled: chatbotEnabled,
            provider: chatProvider,
            model: chatModel,
            provider_ready: Boolean(chatApiKey)
        });
    });

    app.post('/api/chat', async (req, res) => {
        const { chatbotEnabled, chatApiKey, chatProvider, chatBaseUrl, chatModel } = getChatRuntimeConfig();
        const userMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        const context = (req.body?.context && typeof req.body.context === 'object') ? req.body.context : {};
        const history = Array.isArray(req.body?.history) ? req.body.history : [];

        if (!chatbotEnabled) {
            return res.status(403).json({
                success: false,
                error: 'Chatbot đang tắt (CHATBOT_ENABLED=false).'
            });
        }

        if (!userMessage) {
            return res.status(400).json({
                success: false,
                error: 'message là bắt buộc.'
            });
        }

        const safeHistory = history
            .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
            .slice(-8)
            .map(item => ({
                role: item.role,
                content: item.content.trim().slice(0, 3000)
            }));

        const selectedCount = context.selected_count || 'Chưa rõ';
        const reportType = context.report_type || 'chưa chọn';
        const pageTitle = context.page_title || 'Dashboard';
        const syncSource = context.sync_source || 'không rõ';

        const systemPrompt = [
            'Bạn là Trợ lý AI siêu chill của Notion Dashboard. Tính cách: vui nhộn, hài hước kiểu gen-z Việt Nam, nhưng vẫn chính xác.',
            'PHONG CÁCH: Nói chuyện như bạn thân gen-z. Dùng emoji nhiều 🔥✨💀😎🫡. Dùng từ gen-z tự nhiên: "slay", "real", "chill", "oke nha", "ez", "gánh team", "carry", "vibe", "flex", "no cap", "bet", "W", "L", "đỉnh nóc", "xịn sò".',
            'FORMAT: Trả lời NGẮN GỌN, đúng trọng tâm, max 3-5 dòng. KHÔNG lan man. Dùng bullet point cho data.',
            'Nếu user hỏi task/workload → trả lời dựa trên DỮ LIỆU THỰC TẾ được cung cấp trong ngữ cảnh. Đọc kỹ phần DỮ LIỆU THỰC TẾ.',
            'Nếu user chào hỏi/nói linh tinh → trả lời hài hước, ngắn, rồi gợi ý câu hỏi hay.',
            'Nếu không biết → nói thẳng "mình chịu 😅" ĐỪNG bịa data.',
            'LUÔN kết thúc bằng 1-2 gợi ý câu hỏi tiếp theo dạng: "Thử hỏi: ..."'
        ].join(' ');

        // Build data summary from cache for AI context
        let dataSummary = '';
        try {
            const selectedIds = Array.isArray(context?.selected_database_ids) && context.selected_database_ids.length > 0
                ? context.selected_database_ids
                : (Array.isArray(db.getConfig('selected_databases')) ? db.getConfig('selected_databases') : []);
            if (selectedIds.length > 0) {
                let allRows = [];
                const projectNames = [];
                selectedIds.forEach(dbId => {
                    const data = db.getData(dbId);
                    if (Array.isArray(data)) {
                        allRows = allRows.concat(data);
                        if (data.length > 0) {
                            const name = data[0]?.database_name || data[0]?.project_name || '';
                            if (name) projectNames.push(name);
                        }
                    }
                });
                const totalTasks = allRows.length;
                // Count by status
                const byStatus = new Map();
                const assigneeSet = new Set();
                allRows.forEach(r => {
                    const s = r?.Status || r?.status || Object.values(r).find(v => typeof v === 'string' && /done|progress|todo|review/i.test(v)) || 'Unknown';
                    byStatus.set(s, (byStatus.get(s) || 0) + 1);
                    const names = extractAssigneeNames(r);
                    names.forEach(n => assigneeSet.add(n));
                });
                const statusStr = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, c]) => `${s}: ${c}`).join(', ');
                // Build per-project breakdown for AI context
                const perProject = new Map();
                allRows.forEach(r => {
                    const pj = r?.database_name || r?.project_name || '?';
                    perProject.set(pj, (perProject.get(pj) || 0) + 1);
                });
                const projectBreakdown = [...perProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([p, c]) => `${p}: ${c}`).join(', ');
                dataSummary = `\nDỮ LIỆU THỰC TẾ: ${totalTasks} task từ ${projectNames.length} dự án.\nDự án lớn nhất: ${projectBreakdown}.\nTất cả thành viên: ${[...assigneeSet].join(', ')}.\nTrạng thái: ${statusStr}.\nLưu ý: Dùng ĐÚNG tên thành viên như trong danh sách khi trả lời. Nếu user hỏi về 1 người, tìm tên gần nhất trong danh sách.`;
            }
        } catch (e) { /* ignore */ }

        const contextPrompt = `Ngữ cảnh hiện tại: page="${pageTitle}", report="${reportType}", selected="${selectedCount}", sync="${syncSource}".${dataSummary}`;

        const smartReply = buildSmartCacheReplyWithScope(userMessage, context, db);
        if (smartReply) {
            return res.json({
                success: true,
                reply: smartReply
            });
        }

        // AI Intent Classification fallback: rewrite question → retry keyword matching
        if (chatApiKey) {
            try {
                const rewritten = await classifyIntentWithAI(userMessage, chatApiKey, chatBaseUrl);
                if (rewritten) {
                    console.log(`[Chat] AI rewrite: "${userMessage}" → "${rewritten}"`);
                    const smartReply2 = buildSmartCacheReplyWithScope(rewritten, context, db);
                    if (smartReply2) {
                        return res.json({
                            success: true,
                            reply: smartReply2
                        });
                    }
                }
            } catch (err) {
                console.warn('[Chat] AI classification failed:', err.message);
            }
        }

        if (!chatApiKey) {
            return res.json({
                success: true,
                reply: 'Chưa có key AI nên mình chỉ trả lời được mấy câu cơ bản thôi nha 😅\n\nThử hỏi:\n• "Tổng quan task tuần này"\n• "Ai có nhiều task nhất?"\n• "Task quá hạn"'
            });
        }

        try {
            const useGemini = chatProvider === 'gemini' || chatApiKey.startsWith('AIza');
            if (useGemini) {
                const historyText = safeHistory
                    .map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`)
                    .join('\n');
                const geminiBaseUrl = chatBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
                const requestedGeminiModel = String(chatModel || '').replace(/^models\//, '') || 'gemini-2.5-flash';
                const buildGeminiUrl = (modelName) =>
                    `${geminiBaseUrl}/models/${encodeURIComponent(String(modelName).replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(chatApiKey)}`;
                let geminiUrl = buildGeminiUrl(requestedGeminiModel);
                const geminiPrompt = [
                    systemPrompt,
                    contextPrompt,
                    historyText,
                    `User: ${userMessage}`
                ].filter(Boolean).join('\n\n');

                let geminiResponse = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [{ text: geminiPrompt }]
                            }
                        ],
                        generationConfig: {
                            temperature: 0.3,
                            maxOutputTokens: 500
                        }
                    }),
                    signal: AbortSignal.timeout(25000)
                });

                let geminiPayload = await geminiResponse.json();
                if (!geminiResponse.ok && geminiResponse.status === 404) {
                    try {
                        const listResponse = await fetch(`${geminiBaseUrl}/models?key=${encodeURIComponent(chatApiKey)}`, {
                            signal: AbortSignal.timeout(10000)
                        });
                        const listPayload = await listResponse.json();
                        const models = Array.isArray(listPayload?.models) ? listPayload.models : [];
                        const candidates = models.filter(model =>
                            Array.isArray(model?.supportedGenerationMethods) &&
                            model.supportedGenerationMethods.includes('generateContent')
                        );
                        const preferred = candidates.find(model => String(model?.baseModelId || '').startsWith('gemini-2.5-flash'))
                            || candidates.find(model => String(model?.baseModelId || '').includes('flash'))
                            || candidates[0];
                        const fallbackModel = preferred?.baseModelId || String(preferred?.name || '').replace(/^models\//, '');
                        if (fallbackModel) {
                            geminiUrl = buildGeminiUrl(fallbackModel);
                            geminiResponse = await fetch(geminiUrl, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    contents: [
                                        {
                                            parts: [{ text: geminiPrompt }]
                                        }
                                    ],
                                    generationConfig: {
                                        temperature: 0.3,
                                        maxOutputTokens: 500
                                    }
                                }),
                                signal: AbortSignal.timeout(25000)
                            });
                            geminiPayload = await geminiResponse.json();
                            if (geminiResponse.ok) {
                                const geminiReply = geminiPayload?.candidates?.[0]?.content?.parts
                                    ?.map(part => part?.text || '')
                                    .join('')
                                    .trim();
                                if (geminiReply) {
                                    return res.json({
                                        success: true,
                                        reply: geminiReply
                                    });
                                }
                            }
                        }
                    } catch {
                        // Keep original 404 error flow below.
                    }
                }
                if (!geminiResponse.ok) {
                    const errMsg = geminiPayload?.error?.message || '';
                    if (geminiResponse.status === 429 || errMsg.includes('quota') || errMsg.includes('rate')) {
                        return res.json({
                            success: true,
                            reply: getQuotaFallbackReply(userMessage)
                        });
                    }
                    return res.json({
                        success: true,
                        reply: getQuotaFallbackReply(userMessage)
                    });
                }

                const geminiReply = geminiPayload?.candidates?.[0]?.content?.parts
                    ?.map(part => part?.text || '')
                    .join('')
                    .trim();

                if (!geminiReply) {
                    return res.json({
                        success: true,
                        reply: getQuotaFallbackReply(userMessage)
                    });
                }

                return res.json({
                    success: true,
                    reply: geminiReply
                });
            }

            const response = await fetch(`${chatBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${chatApiKey}`
                },
                body: JSON.stringify({
                    model: chatModel,
                    temperature: 0.3,
                    max_tokens: 1024,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'system', content: contextPrompt },
                        ...safeHistory,
                        { role: 'user', content: userMessage }
                    ]
                }),
                signal: AbortSignal.timeout(60000)
            });

            const payload = await response.json();
            if (!response.ok) {
                return res.json({
                    success: true,
                    reply: getQuotaFallbackReply(userMessage)
                });
            }

            let reply = payload?.choices?.[0]?.message?.content;
            if (!reply || typeof reply !== 'string') {
                return res.json({
                    success: true,
                    reply: getQuotaFallbackReply(userMessage)
                });
            }

            // Strip <think>...</think> reasoning blocks from thinking models (Qwen3, DeepSeek, etc.)
            reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            if (!reply) {
                return res.json({
                    success: true,
                    reply: getQuotaFallbackReply(userMessage)
                });
            }

            return res.json({
                success: true,
                reply: reply
            });
        } catch (error) {
            console.warn('[Chat] Error:', error.message);
            return res.json({
                success: true,
                reply: getQuotaFallbackReply(userMessage)
            });
        }
    });

    // ============ WHITELIST / PRIORITY ROUTES ============
    app.get('/api/whitelist', (req, res) => {
        try {
            const priorityData = loadPriorityProjects();
            res.json({
                success: true,
                projects: priorityData.projects || [],
                priority_databases: priorityData.priority_databases || []
            });
        } catch (error) {
            console.error('[API] Error loading whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Pin/Unpin a project to/from the whitelist
    app.post('/api/whitelist/pin', async (req, res) => {
        const { projectId, projectName, action } = req.body; // action: 'pin' or 'unpin'

        if (!projectId || !action) {
            return res.status(400).json({ error: 'projectId and action are required' });
        }

        try {
            const priorityPath = path.join(__dirname, '..', '..', 'data', 'priority_projects.json');
            const priorityData = loadPriorityProjects();

            if (action === 'pin') {
                // Check if already pinned
                const alreadyPinned = priorityData.projects.some(p => p.id === projectId);
                if (alreadyPinned) {
                    return res.json({ success: true, message: 'Project already pinned', alreadyPinned: true });
                }

                // Get project info from active_project_structure.json
                const structurePath = path.join(__dirname, '..', '..', 'data', 'active_project_structure.json');
                let projectInfo = null;

                if (fs.existsSync(structurePath)) {
                    const structureData = JSON.parse(fs.readFileSync(structurePath, 'utf8'));
                    projectInfo = structureData.find(p => p.id === projectId);
                }

                if (!projectInfo) {
                    // Create minimal project info if not found in structure
                    projectInfo = {
                        name: projectName || 'Unknown Project',
                        id: projectId,
                        databases: []
                    };
                }

                // Extract project code from name (e.g., "[DeeDee_2025_SUN] Sunny Side Down" -> "SUN")
                const codeMatch = projectInfo.name.match(/\[.*?_(\w+)\]/);
                const code = codeMatch ? codeMatch[1] : projectInfo.name.slice(0, 5).toUpperCase();

                // Prepare databases with type detection
                const databases = (projectInfo.databases || []).map(db => {
                    let type = 'other';
                    const dbName = (db.title || db.name || '').toLowerCase();
                    if (dbName.includes('task')) type = 'tasks';
                    else if (dbName.includes('product')) type = 'products';
                    else if (dbName.includes('sprint')) type = 'sprints';
                    else if (dbName.includes('report') || dbName.includes('báo cáo')) type = 'reports';
                    else if (dbName.includes('issue')) type = 'issues';

                    return {
                        id: db.id,
                        name: db.title || db.name || 'Unknown',
                        type: type
                    };
                });

                // Add to projects array
                const newProject = {
                    name: projectInfo.name,
                    id: projectId,
                    code: code,
                    databases: databases
                };
                priorityData.projects.push(newProject);

                // Add database IDs to priority_databases array
                databases.forEach(db => {
                    if (!priorityData.priority_databases.includes(db.id)) {
                        priorityData.priority_databases.push(db.id);
                    }
                });

                // Update description
                priorityData.description = `Whitelist dự án ưu tiên - gồm ${priorityData.projects.length} dự án`;

                console.log(`[API] ✅ Pinned project: ${projectInfo.name}`);
            } else if (action === 'unpin') {
                // Find and remove project
                const projectIndex = priorityData.projects.findIndex(p => p.id === projectId);
                if (projectIndex === -1) {
                    return res.json({ success: true, message: 'Project not in whitelist', notFound: true });
                }

                const removedProject = priorityData.projects[projectIndex];

                // Remove database IDs from priority_databases
                const dbIdsToRemove = (removedProject.databases || []).map(db => db.id);
                priorityData.priority_databases = priorityData.priority_databases.filter(
                    dbId => !dbIdsToRemove.includes(dbId)
                );

                // Remove project from array
                priorityData.projects.splice(projectIndex, 1);

                // Update description
                priorityData.description = `Whitelist dự án ưu tiên - gồm ${priorityData.projects.length} dự án`;

                console.log(`[API] ✅ Unpinned project: ${removedProject.name}`);
            } else {
                return res.status(400).json({ error: 'Invalid action. Use "pin" or "unpin"' });
            }

            // Save updated priority_projects.json
            fs.writeFileSync(priorityPath, JSON.stringify(priorityData, null, 2), 'utf8');
            rawFormatCache.clear();

            if (globalProjectsService && typeof globalProjectsService.refreshCache === 'function') {
                globalProjectsService.refreshCache().catch((error) => {
                    console.warn('[API] Projects cache refresh after whitelist update failed:', error.message);
                });
            }

            const warmupScheduled = scheduleBackgroundCacheWarmup(`whitelist_${action}`);

            res.json({
                success: true,
                action: action,
                projectCount: priorityData.projects.length,
                databaseCount: priorityData.priority_databases.length,
                warmup_scheduled: warmupScheduled
            });
        } catch (error) {
            console.error('[API] Error updating whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ============ DATABASE ROUTES ============
    app.get('/api/databases', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });
        try {
            const discovery = new DatabaseDiscovery(token);
            const databases = await discovery.discoverDatabases();
            res.json({ success: true, databases });
        } catch (error) {
            console.error('[API] Error listing databases:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/databases/select', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });
        const { database_ids } = req.body;
        if (!database_ids || !Array.isArray(database_ids)) {
            return res.status(400).json({ error: 'database_ids must be an array' });
        }
        try {
            db.setConfig('selected_databases', database_ids);
            db.setConfig('access_token', notionToken);
            notionToken = getStoredNotionToken();
            req.session.configured = true;
            console.log(`[API] ✅ Saved ${database_ids.length} selected databases`);
            res.json({ success: true, count: database_ids.length });
        } catch (error) {
            console.error('[API] Error saving databases:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/databases/selected', (req, res) => {
        try {
            const selected = db.getConfig('selected_databases') || [];
            res.json({ success: true, databases: selected });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/databases/grouped', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });
        try {
            const discovery = new DatabaseDiscovery(token);
            const allDatabases = await discovery.discoverDatabases();
            const grouped = {};
            for (const db of allDatabases) {
                const projectName = extractProjectName(db.name);
                if (!grouped[projectName]) grouped[projectName] = [];
                grouped[projectName].push({
                    id: db.id,
                    name: db.name,
                    full_name: db.name,
                    properties: db.properties
                });
            }
            res.json({ success: true, projects: grouped });
        } catch (error) {
            console.error('[API] Error grouping databases:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ============ PROJECTS TREE ROUTES ============

    // Get hierarchical project tree from [Chung]Dự án
    app.get('/api/projects/tree', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });
        const projectsService = getProjectsService();
        if (!projectsService) return res.status(500).json({ error: 'Service not initialized' });

        const statusFilter = req.query.status || 'all';

        try {
            // Use Singleton's internal cache mechanism
            const projects = await projectsService.getProjectsTree({ statusFilter });
            res.json({ success: true, projects, cached: true });
        } catch (error) {
            console.error('[API] Error fetching projects tree:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get data for a specific child database
    app.get('/api/projects/database/:id', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });

        const { id } = req.params;

        try {
            // Check cache first
            const cachedData = db.getData(id);
            if (cachedData && cachedData.length > 0) {
                console.log(`[API] Returning cached data for database ${id}`);
                return res.json({ success: true, data: cachedData, cached: true, meta: { title: id } });
            }

            // Fetch fresh data using DataFetcher
            const fetcher = new DataFetcher(token);
            const result = await fetcher.fetchAllData([id]);
            const data = result[id] || [];

            // Cache it
            db.saveData(id, data);

            console.log(`[Fetcher] ✅ Database ${id.slice(0, 8)}...: ${data.length} records`);
            res.json({ success: true, data, cached: false, meta: { title: id } });
        } catch (error) {
            console.error(`[API] Error fetching database ${id}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Clear projects tree cache
    app.post('/api/projects/refresh', async (req, res) => {
        const token = ensureNotionToken();
        if (!token) return res.status(401).json({ error: 'No Notion token configured' });

        try {
            // Clear cache
            db.setConfig('projects_tree_active', null);
            db.setConfig('projects_tree_active_time', null);
            db.setConfig('projects_tree_all', null);
            db.setConfig('projects_tree_all_time', null);
            globalProjectsService = null;

            console.log('[API] Cleared projects tree cache');
            res.json({ success: true, message: 'Cache cleared' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/database/:id/raw', async (req, res) => {
        if (!notionToken) return res.status(401).json({ error: 'No Notion token configured' });
        const { id } = req.params;
        const forceRefresh = req.query.refresh === 'true';
        const queryOptions = parsePaginationParams(req.query);

        try {
            const cachedData = db.getData(id);
            const hasCache = Array.isArray(cachedData);
            const { lookupMap, userMap: globalUserMap } = db.getLookupMaps();
            let databaseName = db.getDatabaseName(id) || null;

            const formatRows = async (records, syncedAt) => {
                const columns = new Set();
                records.forEach(record => {
                    if (record.properties) Object.keys(record.properties).forEach(key => columns.add(key));
                });
                const columnsArr = Array.from(columns);

                const cacheKey = getRawFormatCacheKey(id, syncedAt, queryOptions);
                const cachedFormat = rawFormatCache.get(cacheKey);
                if (cachedFormat && (Date.now() - cachedFormat.createdAt) <= RAW_FORMAT_CACHE_TTL_MS) {
                    return cachedFormat.payload;
                }

                const formattedRows = records.map(record => {
                    const row = {};
                    columnsArr.forEach(col => {
                        row[col] = formatValue(record.properties?.[col], lookupMap, globalUserMap);
                    });
                    return row;
                });

                let resolvedRows = formattedRows;
                const shouldResolveRelations = queryOptions.resolveRelations && records.length <= RAW_RELATION_RESOLVE_MAX_ROWS;
                if (shouldResolveRelations) {
                    resolvedRows = await resolveUnresolvedIds(
                        formattedRows,
                        lookupMap,
                        notionToken,
                        db,
                        relationNameCache
                    );
                    // Persist relation resolution cache lazily after successful enrichment
                    persistRelationNameCache();
                } else if (queryOptions.resolveRelations && records.length > RAW_RELATION_RESOLVE_MAX_ROWS) {
                    console.log(`[API] Skip relation resolution for ${id}: ${records.length} rows > ${RAW_RELATION_RESOLVE_MAX_ROWS}`);
                }

                const paged = applyRawFiltersAndPagination(resolvedRows, columnsArr, queryOptions);
                const payload = {
                    columns: columnsArr,
                    data: paged.data,
                    total_records: resolvedRows.length,
                    total_filtered: paged.pagination.total_filtered,
                    pagination: paged.pagination
                };

                rawFormatCache.set(cacheKey, {
                    createdAt: Date.now(),
                    payload
                });
                pruneRawFormatCache();

                return payload;
            };

            const respondFromRecords = async (records, freshness, extra = {}) => {
                const syncedAt = freshness.synced_at || db.getLastSyncTime(id) || db.getLastUpdate();
                const payload = await formatRows(records, syncedAt);

                return res.json({
                    success: true,
                    database_id: id,
                    database_name: databaseName || 'Unknown Database',
                    ...payload,
                    from_cache: freshness.data_source !== 'notion_api',
                    data_source: freshness.data_source,
                    stale_reason: freshness.stale_reason,
                    synced_at: freshness.synced_at,
                    freshness,
                    ...extra
                });
            };

            const checkpointDueForRaw = db.isFullSyncDue(id, FULL_SYNC_CHECKPOINT_MS);
            if (!forceRefresh && hasCache && cachedData.length > 0) {
                if (checkpointDueForRaw) {
                    const refreshScheduled = scheduleRawDatabaseWarmup(id, 'checkpoint_due');
                    console.log(
                        `[API] Returning cached data for ${id} (checkpoint due; background refresh ${refreshScheduled ? 'scheduled' : 'already running'})`
                    );
                    const freshness = buildFreshnessContract({
                        freshness_status: 'cached',
                        data_source: 'local_cache',
                        synced_at: db.getLastSyncTime(id) || db.getLastUpdate(),
                        stale_reason: refreshScheduled
                            ? 'checkpoint_due_background_refresh_scheduled'
                            : 'checkpoint_due_refresh_in_progress'
                    });
                    return await respondFromRecords(cachedData, freshness, {
                        checkpoint_due: true,
                        refresh_scheduled: refreshScheduled
                    });
                }

                console.log(`[API] Returning cached data for database ${id}`);
                const freshness = buildFreshnessContract({
                    freshness_status: 'cached',
                    data_source: 'local_cache',
                    synced_at: db.getLastSyncTime(id) || db.getLastUpdate()
                });
                return await respondFromRecords(cachedData, freshness);
            }

            console.log(`[API] Fetching fresh data for database ${id}...`);
            const fetcher = new DataFetcher(notionToken, db);
            const result = await fetcher.fetchAllData([id], null, {
                fullSync: true,
                fullSyncCheckpointMs: FULL_SYNC_CHECKPOINT_MS,
                failOnDatabaseError: true
            });
            const data = result[id] || [];

            db.saveData(id, data);
            databaseName = db.getDatabaseName(id) || databaseName;

            const freshness = buildFreshnessContract({
                freshness_status: data.length === 0 ? 'fresh_empty' : 'fresh',
                data_source: 'notion_api',
                synced_at: db.getLastSyncTime(id) || db.getLastUpdate()
            });
            return await respondFromRecords(data, freshness, { empty: data.length === 0 });
        } catch (error) {
            const fallbackData = db.getData(id);
            if (Array.isArray(fallbackData)) {
                console.warn(`[API] Fresh fetch failed for ${id}, serving fallback cache:`, error.message);
                const freshness = buildFreshnessContract({
                    freshness_status: 'fetch_failed_fallback_cache',
                    data_source: 'local_cache_fallback',
                    synced_at: db.getLastSyncTime(id) || db.getLastUpdate(),
                    stale_reason: error.message
                });

                const { lookupMap, userMap: globalUserMap } = db.getLookupMaps();
                const columns = new Set();
                fallbackData.forEach(record => {
                    if (record.properties) Object.keys(record.properties).forEach(key => columns.add(key));
                });
                const columnsArr = Array.from(columns);
                const formattedRows = fallbackData.map(record => {
                    const row = {};
                    columnsArr.forEach(col => {
                        row[col] = formatValue(record.properties?.[col], lookupMap, globalUserMap);
                    });
                    return row;
                });

                let resolvedRows = formattedRows;
                const shouldResolveRelations = queryOptions.resolveRelations && fallbackData.length <= RAW_RELATION_RESOLVE_MAX_ROWS;
                if (shouldResolveRelations) {
                    resolvedRows = await resolveUnresolvedIds(
                        formattedRows,
                        lookupMap,
                        notionToken,
                        db,
                        relationNameCache
                    );
                    persistRelationNameCache();
                } else if (queryOptions.resolveRelations && fallbackData.length > RAW_RELATION_RESOLVE_MAX_ROWS) {
                    console.log(`[API] Skip relation resolution for fallback ${id}: ${fallbackData.length} rows > ${RAW_RELATION_RESOLVE_MAX_ROWS}`);
                }

                const paged = applyRawFiltersAndPagination(resolvedRows, columnsArr, queryOptions);

                return res.status(200).json({
                    success: true,
                    database_id: id,
                    database_name: db.getDatabaseName(id) || 'Unknown Database',
                    columns: columnsArr,
                    data: paged.data,
                    total_records: resolvedRows.length,
                    total_filtered: paged.pagination.total_filtered,
                    pagination: paged.pagination,
                    from_cache: true,
                    data_source: freshness.data_source,
                    stale_reason: freshness.stale_reason,
                    synced_at: freshness.synced_at,
                    freshness
                });
            }

            console.error(`[API] Error fetching database ${id}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // ============ REPORT ROUTES ============
    app.get('/api/reports', (req, res) => {
        const reports = reportRegistry.getAllReports();
        res.json({ success: true, reports });
    });

    app.get('/api/reports/:reportName', async (req, res) => {
        const { reportName } = req.params;
        try {
            const rawData = db.getAllData();
            if (Object.keys(rawData).length === 0) {
                return res.json({ success: false, error: 'No data available.' });
            }
            const result = await reportRegistry.generateReport(reportName, rawData);

            // Add freshness contract
            const lastUpdate = db.getLastUpdate();
            result.freshness = buildFreshnessContract({
                freshness_status: 'cached',
                data_source: 'local_cache',
                synced_at: lastUpdate
            });
            result.data_source = result.freshness.data_source;
            result.stale_reason = result.freshness.stale_reason;
            result.synced_at = result.freshness.synced_at;

            res.json(result);
        } catch (error) {
            console.error(`[API] Error generating report ${reportName}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // ============ PRODUCTIVITY REPORT ROUTES ============
    app.post('/api/reports/productivity', async (req, res) => {
        const { startDate, endDate, databaseIds, standardDays, forceRefresh } = req.body; // YYYY-MM-DD format

        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' });
        }

        try {
            const prodService = new ProductivityService(db);
            const liveFallbacks = [];
            const dataOverrides = {};

            // Static snapshot support is disabled by default to ensure latest data.
            const allowStaticSnapshot = String(process.env.PRODUCTIVITY_USE_STATIC_SNAPSHOT || 'false').toLowerCase() === 'true';
            let isSnapshotLoaded = false;
            let snapshotTime = null;
            if (allowStaticSnapshot) {
                const snapshotPath = path.join(__dirname, '..', '..', '..', 'frontend', 'public', 'data', 'tasks_snapshot.json');
                if (fs.existsSync(snapshotPath)) {
                    try {
                        const snapshotRaw = fs.readFileSync(snapshotPath, 'utf8');
                        const snapshotData = JSON.parse(snapshotRaw);
                        console.log(`[Productivity] Loaded static snapshot with ${snapshotData.records?.length || 0} total records.`);
                        
                        if (Array.isArray(snapshotData.records)) {
                            isSnapshotLoaded = true;
                            snapshotTime = snapshotData._meta?.scanned_at || fs.statSync(snapshotPath).mtime.toISOString();
                            const idSets = {}; // O(1) lookup map
                            for (const record of snapshotData.records) {
                                const dbId = record.database_id;
                                if (!dataOverrides[dbId]) {
                                    const existingCache = db.getData(dbId) || [];
                                    dataOverrides[dbId] = [...existingCache];
                                    idSets[dbId] = new Set(existingCache.map(t => t.id));
                                }
                                
                                // Check deduplication by id in O(1) time
                                if (!idSets[dbId].has(record.id)) {
                                    dataOverrides[dbId].push(record);
                                    idSets[dbId].add(record.id);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[Productivity] Error reading tasks_snapshot.json:', e.message);
                    }
                }
            }

            // If standardDays is provided, save it first
            if (standardDays !== undefined && standardDays !== null) {
                prodService.updateStats(startDate, endDate, { standard_days: standardDays });
            }

            // Ưu tiên dùng databaseIds từ request, fallback về config
            const selectedDatabases = databaseIds && databaseIds.length > 0
                ? databaseIds
                : (db.getConfig('selected_databases') || []);

            if (selectedDatabases.length === 0) {
                return res.json({ success: true, columns: PROD_COLUMNS, data: [], error: 'No projects selected' });
            }

            const refreshedDatabases = [];
            if (forceRefresh) {
                if (!notionToken) {
                    return res.status(401).json({ error: 'No Notion token configured' });
                }

                console.log(`[Productivity] Force refreshing ${selectedDatabases.length} selected Task DBs before report...`);
                const fetcher = new DataFetcher(notionToken, db);
                await fetcher.fetchAllData(selectedDatabases, (dbId, recordCount, syncMeta = {}) => {
                    refreshedDatabases.push({
                        database_id: dbId,
                        database_name: syncMeta.database_name || db.getDatabaseName(dbId) || dbId,
                        rows: recordCount,
                        sync_mode: syncMeta.mode || 'full_sync'
                    });
                }, {
                    fullSync: true,
                    failOnDatabaseError: true
                });
                db.buildLookupCache();
            }

            const startDateObj = new Date(startDate);
            const endDateObj = new Date(endDate);
            const now = new Date();
            // Kiem tra xem date range co phai la thang hien tai khong
            const isCurrentMonth = startDateObj.getFullYear() === now.getFullYear() &&
                startDateObj.getMonth() === now.getMonth();

            for (const dbId of selectedDatabases) {
                // Neu snapshot da co data cho DB nay, bo qua cache/live fallback
                if (dataOverrides[dbId] && dataOverrides[dbId].length > 0) {
                    continue;
                }

                const cachedRows = db.getData(dbId);
                const hasCacheData = Array.isArray(cachedRows) && cachedRows.length > 0;

                if (hasCacheData && isCurrentMonth) {
                    // Thang hien tai: dung cache (du du lieu)
                    continue;
                }

                if (hasCacheData && !isCurrentMonth) {
                    // Thang cu: neu cache lon (>=100 records), gia dinh full sync da chay
                    if (cachedRows.length >= 100) {
                        continue;
                    }
                    console.log(`[Productivity] Cache for ${dbId} has only ${cachedRows.length} rows, trying live fallback for ${startDate} to ${endDate}`);
                }

                if (!hasCacheData) {
                    const knownName = String(db.getDatabaseName(dbId) || '').toLowerCase();
                    if (knownName && !knownName.includes('task')) {
                        continue;
                    }
                }

                try {
                    const liveRows = await fetchTaskRowsForProductivityFallback({
                        databaseId: dbId,
                        startDate,
                        endDate,
                        notionToken,
                        db
                    });

                    if (Array.isArray(liveRows) && liveRows.length > 0) {
                        dataOverrides[dbId] = liveRows;
                        liveFallbacks.push({
                            database_id: dbId,
                            database_name: liveRows[0]?.database_name || db.getDatabaseName(dbId) || dbId,
                            rows: liveRows.length
                        });
                    }
                } catch (error) {
                    console.warn(`[Productivity] Live fallback failed for ${dbId}:`, error.message);
                }
            }

            const { validData, unknownUsers, filterStats } = await prodService.generateReport(startDate, endDate, selectedDatabases, {
                dataOverrides
            });
            const stats = prodService.getStats(startDate, endDate);
            
            // Always use current time for synced_at to show latest generation time
            const syncedAt = new Date().toISOString();
            const dataSource = forceRefresh ? 'notion_api' : (liveFallbacks.length > 0 ? 'mixed_live_cache' : 'local_cache');
            const freshnessStatus = forceRefresh ? 'fresh' : (liveFallbacks.length > 0 ? 'mixed_live_cache' : 'cached');

            res.json({
                success: true,
                columns: PROD_COLUMNS,
                data: validData,
                unknownUsers,
                filterStats,
                stats,
                meta: { startDate, endDate, liveFallbacks, refreshedDatabases },
                freshness: buildFreshnessContract({
                    freshness_status: freshnessStatus,
                    data_source: dataSource,
                    synced_at: syncedAt
                }),
                data_source: dataSource,
                stale_reason: null,
                synced_at: syncedAt
            });
        } catch (error) {
            console.error('[API] Productivity Report Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/reports/productivity/update-stats', async (req, res) => {
        const { startDate, endDate, updates } = req.body;
        if (!startDate || !endDate || !updates) return res.status(400).json({ error: 'Missing parameters' });

        try {
            const prodService = new ProductivityService(db);
            const newStats = prodService.updateStats(startDate, endDate, updates);
            res.json({ success: true, stats: newStats });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ============ SYNC MONITOR ROUTES (Admin Only) ============
    // Middleware: Require admin mode
    const requireAdmin = (req, res, next) => {
        if (process.env.ADMIN_MODE !== 'true') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        next();
    };

    // Get sync overview
    app.get('/api/sync/overview', requireAdmin, async (req, res) => {
        try {
            const syncService = new SyncService(new (await import('@notionhq/client')).Client({ auth: notionToken }), db);
            const selectedDatabases = db.getConfig('selected_databases') || [];
            const priorityData = loadPriorityProjects();
            const priorityDatabases = Array.isArray(priorityData.priority_databases) ? priorityData.priority_databases : [];
            const targetDatabases = [...new Set([...priorityDatabases, ...selectedDatabases])];
            const overview = await syncService.getOverview(targetDatabases);
            res.json({ success: true, data: overview });
        } catch (error) {
            console.error('[API] Sync overview error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Check sync for specific database
    app.post('/api/sync/check', requireAdmin, async (req, res) => {
        const { database_id } = req.body;
        if (!database_id) {
            return res.status(400).json({ error: 'database_id is required' });
        }

        try {
            const syncService = new SyncService(new (await import('@notionhq/client')).Client({ auth: notionToken }), db);
            const result = await syncService.checkDatabase(database_id);
            const mismatchThreshold = parseInt(process.env.SYNC_MISMATCH_THRESHOLD || '0', 10);
            const mismatchMeta = db.getMetadata('mismatch_tracker') || {};
            const prev = mismatchMeta[database_id] || { consecutive_over_threshold: 0 };
            const overThreshold = result.diff_count > mismatchThreshold;
            const consecutive = overThreshold ? (prev.consecutive_over_threshold || 0) + 1 : 0;
            mismatchMeta[database_id] = {
                last_checked_at: new Date().toISOString(),
                diff_count: result.diff_count,
                threshold: mismatchThreshold,
                over_threshold: overThreshold,
                consecutive_over_threshold: consecutive
            };
            db.setMetadata('mismatch_tracker', mismatchMeta);

            // Persist notion count for future reference
            db.setNotionCount(database_id, result.notion_count);

            // Get database name
            const dbInfo = await (new (await import('@notionhq/client')).Client({ auth: notionToken })).databases.retrieve({ database_id });
            const dbName = dbInfo.title?.[0]?.plain_text || 'Unknown';

            res.json({
                success: true,
                data: {
                    ...result,
                    database_name: dbName,
                    mismatch_tracker: mismatchMeta[database_id]
                }
            });
        } catch (error) {
            console.error(`[API] Sync check error for ${database_id}:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Sync correctness summary (pass/fail criteria)
    app.get('/api/sync/correctness', requireAdmin, (req, res) => {
        try {
            const audit = db.getMetadata('sync_audit') || {};
            const fullSyncTimes = db.getMetadata('full_sync_times') || {};
            const mismatchTracker = db.getMetadata('mismatch_tracker') || {};
            const selectedDatabases = db.getConfig('selected_databases') || [];
            const priorityData = loadPriorityProjects();
            const priorityDatabases = Array.isArray(priorityData.priority_databases) ? priorityData.priority_databases : [];
            const targetDatabases = [...new Set([...priorityDatabases, ...selectedDatabases])];
            const targetDbSet = new Set(targetDatabases);
            const checkpointMs = FULL_SYNC_CHECKPOINT_MS;
            const mismatchConsecutiveLimit = parseInt(process.env.SYNC_MISMATCH_CONSECUTIVE_LIMIT || '2', 10);
            const staleCheckpointDbs = targetDatabases
                .filter((dbId) => db.isFullSyncDue(dbId, checkpointMs));

            const excessiveGrowth = Object.entries(audit)
                .filter(([dbId, info]) =>
                    targetDbSet.has(dbId) &&
                    Number(info.deleted || 0) === 0 &&
                    Number(info.new || 0) > 0 &&
                    info.mode === 'incremental_upsert'
                )
                .map(([dbId]) => dbId);

            const mismatchOverThreshold = Object.entries(mismatchTracker)
                .filter(([dbId, info]) =>
                    targetDbSet.has(dbId) &&
                    Number(info.consecutive_over_threshold || 0) >= mismatchConsecutiveLimit
                )
                .map(([dbId]) => dbId);

            const pass = staleCheckpointDbs.length === 0 && mismatchOverThreshold.length === 0;

            res.json({
                success: true,
                pass,
                criteria: {
                    full_sync_checkpoint_ms: checkpointMs,
                    mismatch_consecutive_limit: mismatchConsecutiveLimit,
                    target_databases_count: targetDatabases.length,
                    stale_checkpoint_count: staleCheckpointDbs.length,
                    suspicious_growth_count: excessiveGrowth.length,
                    mismatch_over_threshold_count: mismatchOverThreshold.length
                },
                stale_checkpoint_databases: staleCheckpointDbs,
                suspicious_growth_databases: excessiveGrowth,
                mismatch_over_threshold_databases: mismatchOverThreshold
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ============ SSE-BASED SYNC ALL ============
    // Persisted job storage (recovered on restart)
    pruneFinishedJobs(syncJobs, 10 * 60 * 1000);
    saveSyncJobs();

    // Start sync job
    app.post('/api/sync/start', requireAdmin, async (req, res) => {
        try {
            const { resume = false, max_age_minutes = 10 } = req.body;
            const jobId = Date.now().toString();
            console.log(`[API] Starting sync job ${jobId} (resume: ${resume}, max_age: ${max_age_minutes}min)`);

            syncJobs.set(jobId, {
                progress: 0,
                total: 0,
                status: 'starting',
                results: [],
                synced_databases: [],
                current_db: null,
                resume_mode: resume,
                max_age_minutes: max_age_minutes,
                timeout_ms: parseInt(process.env.SYNC_JOB_TIMEOUT_MS || `${30 * 60 * 1000}`, 10),
                retry_limit: parseInt(process.env.SYNC_JOB_RETRY_LIMIT || '1', 10),
                created_at: new Date().toISOString()
            });
            saveSyncJobs();

            // Start sync asynchronously (don't await)
            startSyncJob(jobId, db, notionToken, syncJobs, null, saveSyncJobs).catch(err => {
                console.error(`[API] Sync job ${jobId} failed:`, err);
                const job = syncJobs.get(jobId);
                if (job) {
                    job.status = 'error';
                    job.error = err.message;
                    saveSyncJobs();
                }
            });

            res.json({ success: true, job_id: jobId });
        } catch (error) {
            console.error('[API] Error starting sync job:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Start single database sync
    app.post('/api/sync/single', requireAdmin, async (req, res) => {
        try {
            const { database_id } = req.body;
            if (!database_id) return res.status(400).json({ error: 'database_id is required' });

            const jobId = Date.now().toString();
            console.log(`[API] Starting single sync job ${jobId} for ${database_id}`);

            syncJobs.set(jobId, {
                progress: 0,
                total: 1,
                status: 'starting',
                results: [],
                synced_databases: [],
                current_db: null,
                resume_mode: false,
                single_mode: true, // Flag for UI
                target_db: database_id,
                timeout_ms: parseInt(process.env.SYNC_JOB_TIMEOUT_MS || `${30 * 60 * 1000}`, 10),
                retry_limit: parseInt(process.env.SYNC_JOB_RETRY_LIMIT || '1', 10),
                created_at: new Date().toISOString()
            });
            saveSyncJobs();

            // Start sync asynchronously with targetDatabaseId
            startSyncJob(jobId, db, notionToken, syncJobs, database_id, saveSyncJobs).catch(err => {
                console.error(`[API] Single sync job ${jobId} failed:`, err);
                const job = syncJobs.get(jobId);
                if (job) {
                    job.status = 'error';
                    job.error = err.message;
                    saveSyncJobs();
                }
            });

            res.json({ success: true, job_id: jobId });
        } catch (error) {
            console.error('[API] Error starting single sync job:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // SSE stream for sync progress
    app.get('/api/sync/stream/:jobId', requireAdmin, (req, res) => {
        const { jobId } = req.params;
        const job = syncJobs.get(jobId);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        console.log(`[API] SSE stream opened for job ${jobId}`);

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

        // Send initial state
        res.write(`data: ${JSON.stringify(job)}\n\n`);

        // Poll for updates every 500ms
        const interval = setInterval(() => {
            const currentJob = syncJobs.get(jobId);

            if (!currentJob) {
                clearInterval(interval);
                res.end();
                return;
            }

            if (currentJob.status === 'running' || currentJob.status === 'retrying') {
                // Send progress update
                res.write(`data: ${JSON.stringify({
                    progress: currentJob.progress,
                    total: currentJob.total,
                    current_db: currentJob.current_db,
                    synced_databases: currentJob.synced_databases || []
                })}\n\n`);
            } else if (currentJob.status === 'complete' || currentJob.status === 'error' || currentJob.status === 'cancelled') {
                res.write(`event: ${currentJob.status}\ndata: ${JSON.stringify(currentJob)}\n\n`);
                clearInterval(interval);

                // Clean up job after 5 seconds
                setTimeout(() => {
                    syncJobs.delete(jobId);
                    console.log(`[API] Cleaned up job ${jobId}`);
                    saveSyncJobs();
                }, 5000);

                res.end();
            }
        }, 500);

        // Clean up on client disconnect
        req.on('close', () => {
            console.log(`[API] SSE stream closed for job ${jobId}`);
            clearInterval(interval);
        });
    });

    // Abort sync job
    app.post('/api/sync/abort/:jobId', requireAdmin, (req, res) => {
        const { jobId } = req.params;
        const job = syncJobs.get(jobId);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        job.status = 'cancelled';
        job.cancelled = true;
        saveSyncJobs();

        console.log(`[API] 🛑 Sync job ${jobId} cancelled by user`);

        res.json({ success: true, message: 'Sync cancelled' });
    });

    // ============ STATUS ROUTES ============
    app.get('/api/status', (req, res) => {
        const lastUpdate = db.getLastUpdate();
        const selectedDatabases = db.getConfig('selected_databases') || [];
        const configured = !!notionToken;
        const sessionAuthenticated = !!req.session?.configured;
        res.json({
            success: true,
            status: 'running',
            last_update: lastUpdate,
            databases_count: selectedDatabases.length,
            authenticated: configured,
            configured,
            session_authenticated: sessionAuthenticated,
            effective_polling_interval_ms: poller?.effectiveIntervalMs || null
        });
    });

    // ============ SYSTEM ROUTES ============
    app.post('/api/refresh', async (req, res) => {
        if (!poller) {
            return res.status(503).json({ error: 'Polling service not available' });
        }
        try {
            console.log('[API] Triggering manual refresh...');
            await poller.triggerPoll();
            // Rebuild lookup cache after refresh
            db.buildLookupCache();
            res.json({ success: true, message: 'Data refreshed successfully' });
        } catch (error) {
            console.error('[API] Refresh failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Rebuild lookup cache (for debugging / maintenance)
    app.post('/api/cache/rebuild', (req, res) => {
        try {
            const startTime = Date.now();
            db.buildLookupCache();
            const elapsed = Date.now() - startTime;
            const { lookupMap, userMap } = db.getLookupMaps();
            res.json({
                success: true,
                message: 'Lookup cache rebuilt',
                stats: {
                    lookupEntries: lookupMap.size,
                    userEntries: userMap.size,
                    elapsedMs: elapsed
                }
            });
        } catch (error) {
            console.error('[API] Cache rebuild failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log('[Routes] ✅ All routes registered');
}


function extractProjectName(databaseName) {
    // Priority: Extract content inside square brackets [Project Name]
    const listPattern = /^\[(.*?)\]/;
    const match = databaseName.match(listPattern);
    if (match && match[1]) {
        return match[1].trim();
    }

    // Fallback: Remove suffixes
    const patterns = [
        / - Product$/i, / - Task$/i, / - Sprint$/i,
        /_Product$/i, /_Task$/i, /_Sprint$/i,
        /Product$/i, /Task$/i, /Sprint$/i
    ];
    let projectName = databaseName;
    for (const pattern of patterns) {
        projectName = projectName.replace(pattern, '').trim();
    }
    return projectName.replace(/[-_\s]+$/, '').trim() || databaseName;
}
/**
 * Resolve any remaining UUIDs in formatted data by fetching page titles from Notion API.
 * This handles relation/rollup IDs that are not in the lookupMap (e.g., pages from unsynced databases).
 * @param {Array} formattedData - Array of formatted row objects
 * @param {Map} lookupMap - The existing lookup map (will be updated with new resolutions)
 * @param {string} notionToken - Notion API token
 * @param {Object} dbManager - DatabaseManager instance to persist resolved names
 * @returns {Promise<Array>} Updated formattedData with IDs replaced by names
 */
/**
 * Resolve any remaining UUIDs in formatted data by fetching page titles from Notion API.
 * Optimized with batching and shared client.
 */
async function resolveUnresolvedIds(formattedData, lookupMap, notionToken, dbManager = null, relationCache = new Map()) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const unresolvedIds = new Set();

    // 1. Collect unique unresolved IDs
    for (const row of formattedData) {
        for (const val of Object.values(row)) {
            if (typeof val === 'string' && val.length > 0) {
                const parts = val.split(', ');
                for (const part of parts) {
                    const trimmed = part.trim();
                    if (uuidRegex.test(trimmed) && !lookupMap.has(trimmed.toLowerCase())) {
                        unresolvedIds.add(trimmed.toLowerCase());
                    }
                }
            }
        }
    }

    if (unresolvedIds.size === 0) return formattedData;

    const resolvedMap = new Map();

    // 1.5 Reuse persisted cache first to avoid extra Notion API calls
    for (const id of unresolvedIds) {
        const cachedName = relationCache.get(id) || relationCache.get(id.toLowerCase());
        if (cachedName) {
            resolvedMap.set(id, cachedName);
            lookupMap.set(id, cachedName);
        }
    }

    const remainingIds = Array.from(unresolvedIds).filter(id => !resolvedMap.has(id));
    if (remainingIds.length === 0) {
        // Apply cached resolutions and return
        for (const row of formattedData) {
            for (const [col, val] of Object.entries(row)) {
                if (typeof val !== 'string' || val.length === 0) continue;
                const parts = val.split(', ');
                const newParts = parts.map(part => {
                    const key = part.trim().toLowerCase();
                    return resolvedMap.get(key) || part;
                });
                row[col] = [...new Set(newParts)].join(', ');
            }
        }
        return formattedData;
    }

    // 2. Resolve in parallel with concurrency limit (e.g., 5 at a time to respect rate limits)
    console.log(`[API] 🔍 Resolving ${remainingIds.length}/${unresolvedIds.size} relation IDs (batch+cache)...`);

    // Use a shared Client if possible (cached at module level)
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ auth: notionToken });

    const idsToResolve = remainingIds.slice(0, 50); // Hard limit per request for safety

    // Simple concurrency pool
    const CONCURRENCY = 5;
    for (let i = 0; i < idsToResolve.length; i += CONCURRENCY) {
        const batch = idsToResolve.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (id) => {
            try {
                const page = await notion.pages.retrieve({ page_id: id });
                let title = '';
                for (const [, prop] of Object.entries(page.properties || {})) {
                    if (prop.type === 'title' && prop.title) {
                        title = prop.title.map(t => t.plain_text).join('');
                        break;
                    }
                }
                const finalTitle = title || '[Untitled]';
                resolvedMap.set(id, finalTitle);
                lookupMap.set(id, finalTitle);
                relationCache.set(id, finalTitle);
            } catch (err) {
                console.warn(`[API] ⚠️ Failed to resolve ${id.substring(0, 8)}: ${err.message}`);
                // Don't add to lookupMap so we can retry later or leave as ID
            }
        }));
        // Small delay between batches to stay under rate limits
        if (i + CONCURRENCY < idsToResolve.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // 3. Apply resolutions to data
    if (resolvedMap.size > 0) {
        for (const row of formattedData) {
            for (const [col, val] of Object.entries(row)) {
                if (typeof val === 'string' && val.length > 0) {
                    const parts = val.split(', ');
                    let changed = false;
                    const newParts = parts.map(part => {
                        const trimmed = part.trim().toLowerCase();
                        if (resolvedMap.has(trimmed)) {
                            changed = true;
                            return resolvedMap.get(trimmed);
                        }
                        return part;
                    });
                    if (changed) {
                        row[col] = [...new Set(newParts)].join(', ');
                    }
                }
            }
        }
        console.log(`[API] ✅ Resolved ${resolvedMap.size} IDs`);
    }

    if (dbManager && resolvedMap.size > 0) {
        const existing = dbManager.getMetadata('relation_name_cache') || {};
        const next = { ...existing };
        resolvedMap.forEach((name, id) => {
            next[id] = name;
        });
        dbManager.setMetadata('relation_name_cache', next);
    }

    return formattedData;
}

/**
 * Helper: Format Notion property value for display (Enhanced Recursive with Lookup)
 */
function formatValue(value, lookupMap = new Map(), globalUserMap = new Map()) {
    // 1. Null/Undefined
    if (value === null || value === undefined) return '';

    // 2. Arrays (Rollup array, Rich Text array, Relation array, etc.)
    if (Array.isArray(value)) {
        if (value.length === 0) return '';

        // Map over items and format recursively
        const formatted = value.map(v => formatValue(v, lookupMap, globalUserMap))
            .filter(v => v !== ''); // Filter empty strings

        // Dedupe to avoid "D, D, D, D, D" display issues
        const unique = [...new Set(formatted)];
        return unique.join(', ');
    }

    // 3. Objects
    if (typeof value === 'object') {

        // --- Notion Type Wrapper --- 
        // Example: { type: "rollup", rollup: { ... } }
        if (value.type && value[value.type] !== undefined) {
            return formatValue(value[value.type], lookupMap, globalUserMap);
        }

        // --- Specific Object Structures ---

        // Rollup specific (sometimes has 'array' property inside)
        if (value.array && Array.isArray(value.array)) {
            return formatValue(value.array, lookupMap, globalUserMap);
        }

        // Title / Rich Text / Text
        if (value.plain_text) return value.plain_text;
        if (value.content) return value.content;

        // Select / Status / Multi-select item
        if (value.name) return value.name;

        // User / People object - Prioritize name over email, but use Map if name is email-like
        if (value.object === 'user' || value.email !== undefined) {
            let name = value.name || value.email || 'Unknown User';
            // Enhance name from map if it looks like an email or is fallback
            if (name.includes('@') && globalUserMap.has(name.toLowerCase().trim())) {
                name = globalUserMap.get(name.toLowerCase().trim());
            }
            return name;
        }

        // People object from fetcher (has name and email)
        if (value.name && value.id) {
            let name = value.name;
            if (name.includes('@') && globalUserMap.has(name.toLowerCase().trim())) {
                name = globalUserMap.get(name.toLowerCase().trim());
            }
            return name;
        }

        // Formula
        if (value.string !== undefined) return value.string;
        if (value.number !== undefined) return String(value.number);
        if (value.boolean !== undefined) return String(value.boolean);

        // Date
        if (value.start) return value.end ? `${value.start} → ${value.end}` : value.start;

        // Checkbox
        if (value.checkbox !== undefined) return String(value.checkbox);

        // URL / Email / Phone
        if (value.url) return value.url;
        if (value.email) return value.email;
        if (value.phone_number) return value.phone_number;

        // Relation Resolution
        // If it's a raw relation object { id: "..." }, we try to look it up.
        if (value.id) {
            const id = value.id.toLowerCase();
            // Check lookup map first
            if (lookupMap.has(id)) {
                return lookupMap.get(id);
            }
            // Fallback: If it's a Relation but not found in map, maybe return a placeholder or just ID
            return value.id;
        }

        // --- Fallback for Deeply Nested / Unknown Objects ---
        try {
            // Handle Title / Rich Text arrays directly if wrapped as object accidentally
            if (value.title && Array.isArray(value.title)) return formatValue(value.title, lookupMap, globalUserMap);
            if (value.rich_text && Array.isArray(value.rich_text)) return formatValue(value.rich_text, lookupMap, globalUserMap);

            // If object has a single key that is an object/array, try diving in
            const keys = Object.keys(value);
            if (keys.length === 1 && typeof value[keys[0]] === 'object') {
                return formatValue(value[keys[0]], lookupMap, globalUserMap);
            }

            // If it has 'string' / 'number' property directly
            if ('string' in value) return value.string;
            if ('number' in value) return String(value.number);

            // Last resort: simple string check
            return JSON.stringify(value).replace(/[{"}]/g, '');
        } catch {
            return '[Complex Data]';
        }
    }

    // 4. Primitives (String, Number, Boolean)
    const strVal = String(value);

    // UUID regex check — supports both dashed (standard) and dashless (Notion relation) formats
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(strVal);
    const isDashlessUUID = !isUUID && /^[0-9a-f]{32}$/i.test(strVal);

    if (isUUID) {
        const id = strVal.toLowerCase();
        if (lookupMap.has(id)) {
            return lookupMap.get(id);
        }
    }

    // Handle dashless UUIDs: normalize to dashed format (8-4-4-4-12) and try lookup
    if (isDashlessUUID) {
        const raw = strVal.toLowerCase();
        const dashed = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
        if (lookupMap.has(dashed)) {
            return lookupMap.get(dashed);
        }
        // Also try raw dashless in case lookupMap has it that way
        if (lookupMap.has(raw)) {
            return lookupMap.get(raw);
        }
    }

    // Check if primitive is an email we can resolve
    if (strVal.includes('@') && globalUserMap.has(strVal.toLowerCase().trim())) {
        return globalUserMap.get(strVal.toLowerCase().trim());
    }

    // Also try checking map even if not strict UUID (for some system IDs)
    if (strVal.length > 20) {
        const id = strVal.toLowerCase();
        if (lookupMap.has(id)) {
            return lookupMap.get(id);
        }
    }

    return strVal;
}

// ============ SSE SYNC JOB HANDLER ============

function pruneFinishedJobs(syncJobsMap, maxAgeMs = 10 * 60 * 1000) {
    const now = Date.now();
    for (const [jobId, job] of syncJobsMap.entries()) {
        if (!['complete', 'error', 'cancelled'].includes(job.status)) continue;
        const finishedAt = job.finished_at ? new Date(job.finished_at).getTime() : now;
        if ((now - finishedAt) > maxAgeMs) {
            syncJobsMap.delete(jobId);
        }
    }
}

async function startSyncJob(jobId, db, notionToken, syncJobsMap, targetDatabaseId = null, persist = () => { }) {
    const job = syncJobsMap.get(jobId);
    if (!job) {
        console.error(`[SyncJob] Job ${jobId} not found`);
        return;
    }

    try {
        job.attempt = (job.attempt || 0) + 1;
        job.started_at = new Date().toISOString();

        const startedAtMs = Date.now();
        const shouldCancel = () => {
            const latestJob = syncJobsMap.get(jobId);
            if (!latestJob) return true;
            if (latestJob.cancelled || latestJob.status === 'cancelled') return true;

            if (latestJob.timeout_ms && latestJob.timeout_ms > 0) {
                if ((Date.now() - startedAtMs) > latestJob.timeout_ms) {
                    latestJob.status = 'error';
                    latestJob.error = `Sync job timed out after ${Math.round(latestJob.timeout_ms / 1000)}s`;
                    latestJob.finished_at = new Date().toISOString();
                    persist();
                    return true;
                }
            }
            return false;
        };

        let databaseIds = [];

        if (targetDatabaseId) {
            // Single database sync mode
            databaseIds = [targetDatabaseId];
            console.log(`[SyncJob ${jobId}] Target specific database: ${targetDatabaseId}`);
        } else {
            // Sync all databases
            const stats = db.getStats();
            databaseIds = stats.cacheFiles.map(f => f.id);
        }

        // Filter out recently synced databases if resume mode
        if (job.resume_mode) {
            const cutoffTime = Date.now() - (job.max_age_minutes * 60 * 1000);
            const originalCount = databaseIds.length;

            databaseIds = databaseIds.filter(dbId => {
                const lastSync = db.getLastSyncTime(dbId);
                if (!lastSync) return true; // Never synced, include

                const syncTime = new Date(lastSync).getTime();
                const ageMinutes = Math.round((Date.now() - syncTime) / 60000);
                const shouldSync = syncTime < cutoffTime;

                if (!shouldSync) {
                    console.log(`[SyncJob ${jobId}] ⏭️  Skipping ${dbId.substring(0, 8)} (synced ${ageMinutes}min ago)`);
                }

                return shouldSync;
            });

            const skippedCount = originalCount - databaseIds.length;
            console.log(`[SyncJob ${jobId}] Resume mode: ${databaseIds.length} databases to sync, ${skippedCount} skipped (synced < ${job.max_age_minutes}min ago)`);
        }

        job.total = databaseIds.length;
        job.status = 'running';
        persist();

        console.log(`[SyncJob ${jobId}] Starting sync for ${databaseIds.length} databases`);

        const { DataFetcher } = await import('../notion/fetcher.js');
        const fetcher = new DataFetcher(notionToken, db);

        let synced = 0;
        const onBatchComplete = (dbId, recordCount, syncMeta = {}) => {
            // Check if cancelled
            if (shouldCancel()) {
                throw new Error('Sync cancelled by user');
            }

            synced++;
            job.progress = synced;
            job.current_db = dbId.substring(0, 8);

            // Track synced database with details
            job.synced_databases.push({
                id: dbId,
                short_id: dbId.substring(0, 8),
                records: recordCount,
                sync_mode: syncMeta.mode || 'unknown',
                timestamp: new Date().toISOString()
            });

            job.results.push({ dbId, recordCount, ...syncMeta });
            console.log(`[SyncJob ${jobId}] ${synced}/${databaseIds.length} - ${dbId.substring(0, 8)}: ${recordCount} records`);
            persist();
        };
        // When targeting a single DB, use fullSync to ensure 100% accuracy (including deleted records removal)
        // When syncing all DBs (batch), use incremental for performance
        const syncOptions = targetDatabaseId
            ? { fullSync: true, shouldCancel, fullSyncCheckpointMs: FULL_SYNC_CHECKPOINT_MS }
            : { shouldCancel, fullSyncCheckpointMs: FULL_SYNC_CHECKPOINT_MS };
        await fetcher.fetchAllData(databaseIds, onBatchComplete, syncOptions);

        if (shouldCancel()) {
            throw new Error('Sync cancelled by user');
        }

        job.total_records = job.results.reduce((sum, r) => sum + r.recordCount, 0);
        job.status = 'complete';
        job.finished_at = new Date().toISOString();
        persist();

        console.log(`[SyncJob ${jobId}] ✅ Complete: ${synced} databases, ${job.total_records} records`);

    } catch (error) {
        console.error(`[SyncJob ${jobId}] ❌ Error:`, error);
        if (job.cancelled) {
            job.status = 'cancelled';
            job.error = null;
            job.finished_at = new Date().toISOString();
            persist();
            return;
        }

        const retryLimit = Number(job.retry_limit || 0);
        if (job.attempt <= retryLimit) {
            job.status = 'retrying';
            job.error = error.message;
            persist();
            return startSyncJob(jobId, db, notionToken, syncJobsMap, targetDatabaseId, persist);
        }

        job.status = 'error';
        job.error = error.message;
        job.finished_at = new Date().toISOString();
        persist();
    }
}


