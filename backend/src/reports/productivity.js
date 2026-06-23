import { SENIORITY_MAPPING, KPI_MAPPING, PRODUCT_TYPE_MAPPING, NAME_ALIAS_MAPPING } from '../constants.js';

export class ProductivityService {
    constructor(db) {
        this.db = db;
        this.personAliasMap = this.buildPersonAliasMap();
        this.personSkeletonMap = this.buildPersonSkeletonMap();
    }

    /**
     * Generate Productivity Report
     * @param {string} startDate - Format "YYYY-MM-DD"
     * @param {string} endDate - Format "YYYY-MM-DD"
     * @param {Array<string>} databaseIds 
     */
    async generateReport(startDate, endDate, databaseIds, options = {}) {
        const stats = this.getStats(startDate, endDate); // Helper to get Manual Inputs
        const reportData = [];
        const dataOverrides = options.dataOverrides || {};

        // Parse date range
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        if (end) {
            end.setHours(23, 59, 59, 999);
        }
        const includeUndatedTasksInCount = !start && !end;

        // 1. Collect all data (Productivity report should use Task databases only)
        let allTasks = [];
        for (const dbId of databaseIds) {
            const data = Array.isArray(dataOverrides[dbId]) ? dataOverrides[dbId] : this.db.getData(dbId);
            if (!Array.isArray(data) || data.length === 0) continue;
            const dbName = String(data[0]?.database_name || '').toLowerCase();
            if (!dbName.includes('task')) {
                continue;
            }
            allTasks = allTasks.concat(data);
        }

        // 2. Filter by Date Range and Status
        console.log(`[Productivity] Processing ${allTasks.length} total tasks from ${databaseIds.length} DBs.`);

        // Debug Counters
        let countStatusReject = 0;
        let countDateMissing = 0;
        let countDateRangeReject = 0;
        let countAssigneeMissing = 0;
        let countAcceptedDone = 0;
        const tasksNoDate = []; // Tasks with empty Ngày Làm - count only, no score
        let missingDateSamples = [];
        let projectsSet = new Set();

        const tasksInRangeAllStatuses = [];
        const relevantTasks = allTasks.filter(task => {
            const status = this.getPropertyValue(task, 'Task Status') || this.getPropertyValue(task, 'Status');
            const statusLower = String(status).toLowerCase();
            const isDone = statusLower === 'done' || statusLower === 'done qc' || statusLower === 'done others';

            // Parse Date
            const doneDate = this.parseDate(task);

            // Check Date Missing
            if (!doneDate) {
                countDateMissing++;
                // Task without "Ngày Làm": still count but don't score
                tasksNoDate.push(task);
                if (missingDateSamples.length < 5) {
                    const propKeys = Object.keys(task.properties).join(', ');
                    missingDateSamples.push({
                        name: this.getPropertyValue(task, 'Name'),
                        project: task.database_name,
                        props: propKeys
                    });
                    console.log(`[DEBUG_DATE_MISSING] Task: "${this.getPropertyValue(task, 'Name')}" | Project: ${task.database_name} | Props: ${propKeys}`);
                }
                return false;
            }

            // Check Date Range
            let inRange = false;
            if ((!start || doneDate >= start) && (!end || doneDate <= end)) {
                inRange = true;
            }

            if (!inRange) {
                countDateRangeReject++;
                return false;
            }

            // Track all tasks in date range regardless of status (for parity with Notion views)
            tasksInRangeAllStatuses.push(task);
            projectsSet.add(task.database_name);

            // Keep productivity metrics based on completed tasks only
            if (!isDone) {
                countStatusReject++;
                return false;
            }

            // Check Assignee
            const assignees = this.getAssignees(task);
            if (assignees.length === 0) {
                countAssigneeMissing++;
                // Still keep it? No, grouping will put it in undefined?
                // The logic below groups by assignee. If empty, it's lost?
                // Actually loop 3 iterates assignees. If empty, task is ignored.
            }

            countAcceptedDone++;
            return true;
        });

        console.log(`[Productivity] Filter Stats:`);
        console.log(`- Total Accepted (All statuses): ${tasksInRangeAllStatuses.length}`);
        console.log(`- Total Accepted (Done only): ${countAcceptedDone}`);
        console.log(`- Rejected (Status != Done): ${countStatusReject}`);
        console.log(`- Rejected (Date Missing/Invalid): ${countDateMissing}`);
        console.log(`- Rejected (Date Out of Range): ${countDateRangeReject}`);
        console.log(`- Missing Assignee (Potential Loss): ${countAssigneeMissing} (Included in Accepted but might be lost in grouping)`);

        console.log(`[Productivity] Metrics calculated. Relevant Tasks: ${relevantTasks.length}`);

        // 3. Group by Assignee (done tasks for productivity metrics)
        const grouped = {};
        for (const task of relevantTasks) {
            const assignees = this.getAssignees(task);

            for (const person of assignees) {
                if (!grouped[person]) grouped[person] = [];
                grouped[person].push(task);
            }
        }

        // Group all in-range tasks for task count shown on report
        const groupedAllInRange = {};
        const projectsByPerson = {};
        for (const task of tasksInRangeAllStatuses) {
            const assignees = this.getAssignees(task);
            const projectName = this.getProjectName(task);
            for (const person of assignees) {
                if (!groupedAllInRange[person]) groupedAllInRange[person] = [];
                groupedAllInRange[person].push(task);
                if (!projectsByPerson[person]) projectsByPerson[person] = new Set();
                if (projectName) {
                    projectsByPerson[person].add(projectName);
                }
            }
        }

        // Group tasks with no date for counting only (no scoring)
        const groupedNoDate = {};
        for (const task of tasksNoDate) {
            const assignees = this.getAssignees(task);
            for (const person of assignees) {
                if (!groupedNoDate[person]) groupedNoDate[person] = 0;
                groupedNoDate[person]++;
            }
        }

        // 4. Build Rows per Assignee
        const assigneesFromData = [...new Set([...Object.keys(grouped), ...Object.keys(groupedAllInRange)])];
        const presetPersonnel = Object.keys(SENIORITY_MAPPING);
        // reportData is already declared at top

        // Combine: data assignees first, then any preset not in data
        const allPersonnel = [...assigneesFromData];
        for (const preset of presetPersonnel) {
            if (!allPersonnel.includes(preset)) {
                allPersonnel.push(preset);
            }
        }

        const unknownSeniority = 'Ch\u01b0a x\u00e1c \u0111\u1ecbnh';
        const seenPersonnel = new Set();

        for (const rawPersonName of allPersonnel) {
            const personName = this.resolvePersonName(rawPersonName);
            if (!personName || seenPersonnel.has(personName)) {
                continue;
            }
            seenPersonnel.add(personName);

            // Try to find seniority - exact match first, then fuzzy
            let seniority = SENIORITY_MAPPING[personName];
            if (!seniority) {
                const knownNames = Object.keys(SENIORITY_MAPPING);
                const normalizedRaw = this.removeAccents(personName.toLowerCase());

                const match = knownNames.find(known => {
                    const normalizedKnown = this.removeAccents(known.toLowerCase());
                    return normalizedRaw.includes(normalizedKnown) || normalizedKnown.includes(normalizedRaw);
                });
                seniority = match ? SENIORITY_MAPPING[match] : unknownSeniority;
            }

            const kpi = KPI_MAPPING[seniority] || 0;
            const tasksDone = grouped[personName] || grouped[rawPersonName] || [];
            const tasksAllInRange = groupedAllInRange[personName] || groupedAllInRange[rawPersonName] || [];

            // Manual Inputs
            const standardDays = stats.standard_days || 0;
            const actualDays = stats.actual_days?.[personName] || stats.actual_days?.[rawPersonName] || 0;

            // Calculate metrics for both scopes:
            // - all-status tasks: totals shown in report and completion point fields
            // - done-only tasks: productivity and completion productivity fields
            const metricsDone = this.calculateMetrics(tasksDone, kpi, standardDays, actualDays);
            const metricsAll = this.calculateMetrics(tasksAllInRange, kpi, standardDays, actualDays);

            reportData.push({
                fullName: personName,
                seniority,
                productivityReq: kpi,
                standardDays,
                actualDays,
                // Monthly/date-range reports should only count tasks that can be placed in the range.
                taskCount: tasksAllInRange.length + (
                    includeUndatedTasksInCount
                        ? (groupedNoDate[personName] || groupedNoDate[rawPersonName] || 0)
                        : 0
                ),
                taskCountDone: tasksDone.length,
                taskCountAllStatuses: tasksAllInRange.length,
                projects: projectsByPerson[personName] || projectsByPerson[rawPersonName]
                    ? [...(projectsByPerson[personName] || projectsByPerson[rawPersonName])].sort((a, b) => a.localeCompare(b, 'vi')).join(', ')
                    : '',
                pointReq: metricsAll.pointReq,
                effortConfirmed: metricsAll.effortConfirmed,
                effortUnconfirmed: metricsAll.effortUnconfirmed,
                effortTotal: metricsAll.effortTotal,
                pointConfirmed: metricsAll.pointConfirmed,
                pointUnconfirmed: metricsAll.pointUnconfirmed,
                pointTotal: metricsAll.pointTotal,
                completionPointConfirmed: metricsAll.completionPointConfirmed,
                completionPointTotal: metricsAll.completionPointTotal,
                effortRatio: metricsAll.effortRatio,
                productivityConfirmed: metricsDone.productivityConfirmed,
                productivityUnconfirmed: metricsDone.productivityUnconfirmed,
                productivityTotal: metricsDone.productivityTotal,
                completionProdConfirmed: metricsDone.completionProdConfirmed,
                completionProdTotal: metricsDone.completionProdTotal,
                pointTotalDone: metricsDone.pointTotal
            });
        }

        const validData = reportData.filter(r => r.seniority !== unknownSeniority);

        // For unknown users, just return name and task count
        const unknownUsers = reportData
            .filter(r => r.seniority === unknownSeniority)
            .map(r => ({
                name: r.fullName,
                taskCount: r.taskCount
            }));

        const filterStats = {
            totalProcessed: allTasks.length,
            totalInRangeAllStatuses: tasksInRangeAllStatuses.length,
            totalAccepted: tasksInRangeAllStatuses.length,
            totalAcceptedDone: countAcceptedDone,
            rejectedStatus: countStatusReject,
            rejectedDateMissing: countDateMissing,
            rejectedDateRange: countDateRangeReject,
            missingAssignee: countAssigneeMissing,
            includedUndatedInTaskCount: includeUndatedTasksInCount,
            missingDateSamples: missingDateSamples || [],
            projects: Array.from(projectsSet)
        };

        return { validData, unknownUsers, filterStats };
    }

    getProjectName(task) {
        const normalizeProjectName = (input) => {
            const raw = String(input || '').trim();
            if (!raw) return '';
            const bracketMatch = raw.match(/^\[(.*?)\]/);
            if (bracketMatch?.[1]) {
                return bracketMatch[1].trim();
            }
            return raw.replace(/\s*tasks?\s*$/i, '').trim();
        };

        const direct = task?.project_name;
        if (direct && String(direct).trim()) {
            const normalized = normalizeProjectName(direct);
            if (normalized) return normalized;
        }

        const dbName = String(task?.database_name || '').trim();
        if (!dbName) return '';
        return normalizeProjectName(dbName);
    }

    normalizePropertyLookupKey(name) {
        return this.removeAccents(String(name || '').toLowerCase().replace(/đ/g, 'd'))
            .replace(/[^a-z0-9]+/g, '');
    }

    buildPropertySkeleton(name) {
        return this.normalizePropertyLookupKey(name).replace(/[aeiouy]+/g, '');
    }

    calculateMetrics(tasks, kpi, standardDays, actualDays) {
        // C6: Task point req
        const pointReq = kpi * actualDays * 2;

        let effortConf = 0;   // C7
        let effortUnconf = 0; // C8
        let pointConf = 0;    // C10
        let pointUnconf = 0;  // C11

        for (const task of tasks) {
            // All products count, no Product Type filter
            // Only separate by Point Status: Confirmed vs Unconfirmed
            const pointStatus = this.getPropertyValue(task, 'Point Status', 'POINT STATUS', 'point status');

            // Task points - try multiple property names
            const pointVal = parseFloat(this.getPropertyValue(task, 'TP thực tế', 'TP THỰC TẾ', 'Task Point', 'TASK POINT') || 0);
            // Effort - try multiple property names  
            const effortVal = parseFloat(this.getPropertyValue(task, 'NLTT', 'nltt', 'Actual Effort', 'actual effort') || 0);

            if (String(pointStatus).toLowerCase() === 'confirmed') {
                effortConf += effortVal;
                pointConf += pointVal;
            } else {
                // All other statuses (including Unconfirmed, empty, etc.) go to Unconfirmed bucket
                effortUnconf += effortVal;
                pointUnconf += pointVal;
            }
        }

        const effortTotal = effortConf + effortUnconf; // C9
        const pointTotal = pointConf + pointUnconf;    // C12

        // Ratios - Productivity = Point / Effort
        const productivityConf = effortConf ? (pointConf / effortConf) : 0; // C13 (N)
        const productivityUnconf = effortUnconf ? (pointUnconf / effortUnconf) : 0; // C14 (O)
        const productivityTotal = effortTotal ? (pointTotal / effortTotal) : 0; // C15 (P)

        // Q: Completion Productivity Confirmed = Actual Productivity / Required Productivity (KPI)
        // Formula: (pointConf / effortConf) / KPI = productivityConf / KPI
        const completionProdConf = kpi ? (productivityConf / kpi) : null; // C16 (Q)

        // R: Completion Productivity Total = Total Productivity / Required Productivity (KPI)
        // Formula: (pointTotal / effortTotal) / KPI = productivityTotal / KPI
        const completionProdTotal = kpi ? (productivityTotal / kpi) : null; // C17 (R)

        // S: Completion Task Point Confirmed = Point Confirmed / Point Required
        const completionPointConf = pointReq ? (pointConf / pointReq) : null; // C18 (S)

        // T: Completion Task Point Total = Point Total / Point Required  
        const completionPointTotal = pointReq ? (pointTotal / pointReq) : null; // C19 (T)

        const effortRatio = (actualDays * 2) ? (effortTotal / (actualDays * 2)) : 0; // C20 (U) - Updated to use actualDays

        return {
            pointReq,
            effortConfirmed: effortConf,
            effortUnconfirmed: effortUnconf,
            effortTotal,
            pointConfirmed: pointConf,
            pointUnconfirmed: pointUnconf,
            pointTotal,
            productivityConfirmed: productivityConf,
            productivityUnconfirmed: productivityUnconf,
            productivityTotal,
            completionProdConfirmed: completionProdConf,
            completionProdTotal,
            completionPointConfirmed: completionPointConf,
            completionPointTotal,
            effortRatio
        };
    }

    /**
     * Get property value with case-insensitive fallback
     * Tries exact match first, then case-insensitive search
     */
    getPropertyValue(task, ...propNames) {
        const props = task.properties;
        if (!props) return null;

        // Try each property name in order
        for (const propName of propNames) {
            // 1. Try exact match first
            let value = props[propName];

            // 2. If not found, try case-insensitive match
            if (value === null || value === undefined) {
                const lowerName = propName.toLowerCase();
                const matchingKey = Object.keys(props).find(k => k.toLowerCase() === lowerName);
                if (matchingKey) {
                    value = props[matchingKey];
                }
            }

            // 3. Accent-insensitive normalized match
            if (value === null || value === undefined) {
                const normalizedName = this.normalizePropertyLookupKey(propName);
                const matchingKey = Object.keys(props).find(k => this.normalizePropertyLookupKey(k) === normalizedName);
                if (matchingKey) {
                    value = props[matchingKey];
                }
            }

            // 4. Skeleton match for mojibake keys such as "Ng�y l�m", "TP th?c t?"
            if (value === null || value === undefined) {
                const skeletonName = this.buildPropertySkeleton(propName);
                const matchingKey = Object.keys(props).find(k => this.buildPropertySkeleton(k) === skeletonName);
                if (matchingKey) {
                    value = props[matchingKey];
                }
            }

            // If found, extract and return
            if (value !== null && value !== undefined) {
                return this.extractValue(value);
            }
        }

        return null;
    }

    /**
     * Extract actual value from Notion's nested structure
     */
    extractValue(value) {
        if (value === null || value === undefined) return null;

        // Handle array with nested objects (common in Notion rollups/formulas/relations)
        if (Array.isArray(value)) {
            if (value.length === 0) return null;

            // Check if it's an array of relation objects (have 'id' property)
            // Relations look like: [{id: "xxx-xxx"}, {id: "yyy-yyy"}]
            if (value[0] && typeof value[0] === 'object') {
                const first = value[0];

                // Formula wrapper
                if (first.type === 'formula' && first.formula) {
                    const f = first.formula;
                    return f.string ?? f.number ?? f.boolean ?? null;
                }
                // Select wrapper
                if (first.type === 'select' && first.select) {
                    return first.select.name || null;
                }
                // Status wrapper
                if (first.type === 'status' && first.status) {
                    return first.status.name || null;
                }
                // Number wrapper
                if (first.type === 'number') {
                    return first.number;
                }
                // Title/rich_text - extract plain text
                if (first.type === 'text' || first.plain_text !== undefined) {
                    return value.map(v => v.plain_text || '').join('');
                }
                // Relation - extract titles if available, otherwise return names from rollup
                if (first.id && !first.type) {
                    // This is a relation array - just IDs, will be handled by formatValue
                    return value;
                }
            }

            // Array of primitives
            if (typeof value[0] !== 'object') {
                return value.join(', ');
            }
        }

        return value;
    }

    /**
     * Format value for display - handle objects, arrays, etc.
     */
    formatValue(value) {
        if (value === null || value === undefined) return '-';
        if (typeof value === 'string') return value || '-';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';

        // Handle date object
        if (value instanceof Date) {
            return value.toLocaleDateString('vi-VN');
        }

        // Handle object with start/end (date range)
        if (typeof value === 'object' && !Array.isArray(value) && (value.start || value.end)) {
            const dateStr = value.end || value.start;
            if (dateStr) {
                const d = new Date(dateStr);
                return !isNaN(d.getTime()) ? d.toLocaleDateString('vi-VN') : dateStr;
            }
            return '-';
        }

        // Handle array (relations, rollups, multi-select)
        if (Array.isArray(value)) {
            if (value.length === 0) return '-';

            // Check if it's an array of UUIDs (relation IDs) - these can't be resolved to names
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (typeof value[0] === 'string' && uuidRegex.test(value[0])) {
                return '-'; // Can't display relation IDs, need rollup for names
            }

            // Check what type of array items we have
            const results = value.map(item => {
                if (item === null || item === undefined) return '';
                if (typeof item === 'string') {
                    // Skip UUID strings
                    if (uuidRegex.test(item)) return null;
                    return item;
                }
                if (typeof item === 'number') return String(item);

                // Object with various possible structures
                if (typeof item === 'object') {
                    // Has name (select, multi-select, status)
                    if (item.name) return item.name;
                    // Has title (relation with title rollup)
                    if (item.title) {
                        if (Array.isArray(item.title)) {
                            return item.title.map(t => t.plain_text || '').join('');
                        }
                        return item.title;
                    }
                    // Has plain_text (rich text)
                    if (item.plain_text !== undefined) return item.plain_text;
                    // Relation object with just ID - skip (can't resolve without API call)
                    if (item.id && Object.keys(item).length <= 2) return null;
                    // Nested object
                    return this.formatValue(item);
                }
                return '';
            }).filter(v => v !== null && v !== '');

            return results.length > 0 ? results.join(', ') : '-';
        }

        // Handle object with name property (select, status)
        if (typeof value === 'object' && value.name) {
            return value.name;
        }

        // Handle object with title property
        if (typeof value === 'object' && value.title) {
            if (Array.isArray(value.title)) {
                return value.title.map(t => t.plain_text || '').join('');
            }
            return String(value.title);
        }

        // Handle object with plain_text
        if (typeof value === 'object' && value.plain_text !== undefined) {
            return value.plain_text || '-';
        }

        // Fallback for unknown objects
        if (typeof value === 'object') {
            // Try to extract any meaningful string
            const str = JSON.stringify(value);
            // If it's just an ID object, return dash
            if (str.includes('"id"') && !str.includes('"name"') && !str.includes('"title"')) {
                return '-';
            }
        }

        return '-';
    }

    /**
     * Parse date from DoneDate column (priority) or fallback columns
     * Returns null if column is empty - those tasks will be skipped
     */
    parseDate(task) {
        const props = task.properties;
        if (!props) return null;

        const extractDate = (rawValue) => {
            let dateValue = rawValue;

            if (dateValue === null || dateValue === undefined || dateValue === '') return null;
            if (Array.isArray(dateValue) && dateValue.length === 0) return null;

            if (typeof dateValue === 'object') {
                if (dateValue.type === 'formula') {
                    const f = dateValue.formula || {};
                    dateValue = f.string || f.date || f.number || null;
                } else if (dateValue.type === 'rollup') {
                    if (Array.isArray(dateValue.rollup?.array)) {
                        const arr = dateValue.rollup.array;
                        const last = arr[arr.length - 1];
                        dateValue = last?.start || last?.formula?.string || last || null;
                    } else {
                        dateValue = null;
                    }
                } else if (dateValue.type === 'date' && dateValue.date) {
                    dateValue = dateValue.date;
                } else if (Array.isArray(dateValue.rich_text)) {
                    dateValue = dateValue.rich_text[0]?.plain_text || null;
                } else if (Array.isArray(dateValue.title)) {
                    dateValue = dateValue.title[0]?.plain_text || null;
                }
            }

            if (!dateValue) return null;

            if (typeof dateValue === 'object' && dateValue.start) {
                const dateStr = dateValue.end || dateValue.start;
                const parsed = new Date(dateStr);
                return Number.isNaN(parsed.getTime()) ? null : parsed;
            }

            if (typeof dateValue === 'string') {
                return this.parseStringDate(dateValue);
            }

            return null;
        };

        const entries = Object.entries(props);
        const ngayLamSkeleton = this.buildPropertySkeleton('Ngay lam');
        const ngayLamEntry = entries.find(([key]) => this.buildPropertySkeleton(key) === ngayLamSkeleton);
        if (ngayLamEntry) {
            // Strict mode: if "Ngay lam" exists but empty/invalid, skip this task.
            return extractDate(ngayLamEntry[1]);
        }

        // Strict "Ngay lam only" mode: no fallback to any other date column.
        return null;
    }

    /**
     * Parse string date in various formats
     */
    parseStringDate(rawDate) {
        if (!rawDate) return null;
        rawDate = rawDate.trim();

        // Handle Range string "Date1 -> Date2" (common in Notion formula output)
        if (rawDate.includes('->')) {
            const parts = rawDate.split('->');
            // Use End Date (last part) for month assignment
            rawDate = parts[parts.length - 1].trim();
        }

        // ISO Date (YYYY-MM-DD)
        if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
            return new Date(rawDate);
        }

        // DD/MM/YYYY or DD-MM-YYYY
        const ddmmyyyy = rawDate.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
        if (ddmmyyyy) {
            const day = parseInt(ddmmyyyy[1]);
            const month = parseInt(ddmmyyyy[2]) - 1;
            const year = parseInt(ddmmyyyy[3]);
            return new Date(year, month, day);
        }

        // Fallback: Let JS Date constructor try
        const fallback = new Date(rawDate);
        if (!isNaN(fallback.getTime())) return fallback;

        return null;
    }

    // Deprecated but kept for compatibility if needed (aliased to parseDate)
    getDataDate(task) {
        return this.parseDate(task);
    }

    normalizePersonName(name) {
        return this.removeAccents(String(name || '').toLowerCase().replace(/đ/g, 'd'))
            .replace(/[^a-z0-9]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    buildPersonSkeleton(name) {
        return this.normalizePropertyLookupKey(name).replace(/[aeiouy]+/g, '');
    }

    buildPersonAliasMap() {
        const map = new Map();
        const addAlias = (alias, canonical) => {
            const normalizedAlias = this.normalizePersonName(alias);
            if (!normalizedAlias || !canonical) return;
            if (!map.has(normalizedAlias)) {
                map.set(normalizedAlias, canonical);
            }
        };

        for (const [alias, canonical] of Object.entries(NAME_ALIAS_MAPPING)) {
            addAlias(alias, canonical);
        }
        for (const canonical of Object.keys(SENIORITY_MAPPING)) {
            addAlias(canonical, canonical);
        }

        return map;
    }

    buildPersonSkeletonMap() {
        const map = new Map();
        const addAlias = (alias, canonical) => {
            const skeletonAlias = this.buildPersonSkeleton(alias);
            if (!skeletonAlias || !canonical) return;
            if (!map.has(skeletonAlias)) {
                map.set(skeletonAlias, canonical);
            }
        };

        for (const [alias, canonical] of Object.entries(NAME_ALIAS_MAPPING)) {
            addAlias(alias, canonical);
        }
        for (const canonical of Object.keys(SENIORITY_MAPPING)) {
            addAlias(canonical, canonical);
        }

        return map;
    }

    resolvePersonName(rawName) {
        const raw = String(rawName || '').trim();
        if (!raw) return '';

        const directAlias = NAME_ALIAS_MAPPING[raw];
        if (directAlias) return directAlias;

        const normalizedRaw = this.normalizePersonName(raw);
        const fixedMatch = this.personAliasMap.get(normalizedRaw);
        if (fixedMatch) return fixedMatch;
        const skeletonRaw = this.buildPersonSkeleton(raw);
        const skeletonMatch = this.personSkeletonMap.get(skeletonRaw);
        if (skeletonMatch) return skeletonMatch;

        const stripped = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped && stripped !== raw) {
            const strippedAlias = NAME_ALIAS_MAPPING[stripped];
            if (strippedAlias) return strippedAlias;

            const normalizedStripped = this.normalizePersonName(stripped);
            const strippedMatch = this.personAliasMap.get(normalizedStripped);
            if (strippedMatch) return strippedMatch;
            const strippedSkeleton = this.buildPersonSkeleton(stripped);
            const strippedSkeletonMatch = this.personSkeletonMap.get(strippedSkeleton);
            if (strippedSkeletonMatch) return strippedSkeletonMatch;
        }

        for (const canonical of Object.keys(SENIORITY_MAPPING)) {
            const normalizedCanonical = this.normalizePersonName(canonical);
            if (normalizedCanonical && normalizedRaw.includes(normalizedCanonical)) {
                return canonical;
            }
            const canonicalSkeleton = this.buildPersonSkeleton(canonical);
            if (canonicalSkeleton && skeletonRaw && skeletonRaw === canonicalSkeleton) {
                return canonical;
            }
        }

        return raw;
    }

    getAssignees(task) {
        // Try Assignee first, then Owner as fallback.
        const props = task.properties || {};
        const keys = [
            'Assignee',
            'Owner',
            'assignee',
            'owner',
            'Người thực hiện',
            'Người xử lý',
            'Nhân sự',
            'Person'
        ];

        let assignees = null;
        for (const key of keys) {
            if (props[key]) {
                assignees = props[key];
                break;
            }
        }

        if (!assignees) return [];

        if (Array.isArray(assignees)) {
            return assignees
                .map(person => this.resolvePersonName(person?.name || ''))
                .filter(Boolean);
        }

        if (typeof assignees === 'string') {
            const resolved = this.resolvePersonName(assignees);
            return resolved ? [resolved] : [];
        }

        return [];
    }

    removeAccents(str) {
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    // Stats Management for Inputs
    // Now uses date range key like "2024-01-01_2024-01-31"
    getStats(startDate, endDate) {
        const key = `${startDate || 'all'}_${endDate || 'all'}`;
        const meta = this.db.getMetadata('monthly_stats') || {};
        return meta[key] || { standard_days: 0, actual_days: {} };
    }

    updateStats(startDate, endDate, updates) {
        const key = `${startDate || 'all'}_${endDate || 'all'}`;
        const meta = this.db.getMetadata('monthly_stats') || {};
        if (!meta[key]) meta[key] = { standard_days: 0, actual_days: {} };

        if (updates.standard_days !== undefined) meta[key].standard_days = parseFloat(updates.standard_days);
        if (updates.actual_days) {
            meta[key].actual_days = { ...meta[key].actual_days, ...updates.actual_days };
        }

        this.db.setMetadata('monthly_stats', meta);
        return meta[key];
    }
}
