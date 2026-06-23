import { BaseReport } from './base-report.js';

/**
 * Raw Tasks Report
 * Returns all tasks with detailed information
 */
export class RawTasksReport extends BaseReport {
    constructor() {
        super('raw-tasks-report', 'Danh Sách Công Việc');
    }

    calculate(rawData) {
        const allRecords = Object.values(rawData).flat();

        // 1. Build ID -> Name Map to resolve map Relation IDs to Titles
        const idToNameMap = new Map();

        for (const record of allRecords) {
            // Use _title if available (reliable from fetcher), otherwise try properties
            let name = record._title;

            if (!name && record.properties) {
                // Try common title keys
                const titleProp = record.properties['Name'] ||
                    record.properties['Title'] ||
                    record.properties['Tên'] ||
                    record.properties['Task Name'] ||
                    record.properties['Project Name'];

                if (typeof titleProp === 'string') name = titleProp;
            }

            if (record.id && name) {
                idToNameMap.set(record.id, name);
            }
        }

        // 2. Map records and resolve values
        return allRecords.map(record => {
            // Create a resolved properties object
            const resolvedProps = {};
            const originalProps = record.properties || {};

            for (const [key, value] of Object.entries(originalProps)) {
                resolvedProps[key] = this.resolveProperty(value, idToNameMap);
            }

            return {
                id: record.id,
                created_time: record.created_time,
                last_edited_time: record.last_edited_time,
                properties: resolvedProps,
                _original_properties: originalProps // Keep original just in case
            };
        });
    }

    /**
     * Helper to resolve/format any property value
     */
    resolveProperty(value, map) {
        if (value === null || value === undefined) return '';

        // Handle Arrays (Relations, Rollups, People, Multi-select)
        if (Array.isArray(value)) {
            if (value.length === 0) return '';

            // Check content type based on first element
            const first = value[0];

            // 1. Array of Strings (likely Relation IDs or Multi-select strings)
            if (typeof first === 'string') {
                // Check if it looks like a UUID (Relation)
                if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(first)) {
                    return value.map(id => map.get(id) || id).join(', '); // Resolve or keep ID
                }
                return value.join(', '); // Just strings
            }

            // 2. Array of Objects (People, rich text, or complex rollup)
            if (typeof first === 'object') {
                // People objects
                if (first.name && first.email) return value.map(p => p.name).join(', ');

                // Rich Text / Title [{ plain_text: ... }]
                if (first.plain_text) return value.map(t => t.plain_text).join('');

                // Rollup/Relation objects inside array (if fetcher missed flattening)
                // usually fetcher flattens relations to IDs, but Rollups might be raw
                return value.map(item => this.resolveProperty(item, map)).join(', ');
            }

            return JSON.stringify(value);
        }

        // Handle Objects
        if (typeof value === 'object') {
            // Handle Notion Typed Objects (e.g. { type: 'rollup', rollup: ... })
            if (value.type && value[value.type] !== undefined) {
                return this.resolveProperty(value[value.type], map);
            }

            // Already handled in fetcher mostly, but just in case
            if (value.name) return value.name; // Select, Status
            if (value.start) return value.end ? `${value.start} -> ${value.end}` : value.start; // Date

            // Relation object inside Rollup (sometimes just { id: '...' })
            if (value.id) {
                return map.get(value.id) || value.id;
            }
        }

        return value;
    }

    format(calculatedData) {
        // Extract and flatten common properties for easier frontend display
        return calculatedData.map(record => {
            const props = record.properties;

            return {
                id: record.id,
                created_time: record.created_time,
                last_edited_time: record.last_edited_time,

                // Common fields with robust lookup (Case Insensitive strategy)
                name: this.findProp(props, ['Name', 'name', 'Tên task', 'Tên', 'Title']),
                status: this.findProp(props, ['Status', 'status', 'Trạng thái']),
                assignee: this.findProp(props, ['Assignee', 'assignee', 'Người làm', 'Người thực hiện', 'Owner']),
                sprint: this.findProp(props, ['Sprint', 'sprint', 'Sprint Name', 'Đợt']),
                product: this.findProp(props, ['Product', 'product', 'Sản phẩm', 'Dự án']),
                task_point: this.findProp(props, ['Task point', 'task_point', 'Point', 'Points', 'Working hours']),
                actual_hours: this.findProp(props, ['Số công thực tế', 'actual_hours']),
                expected_hours: this.findProp(props, ['Số công yêu cầu', 'expected_hours']),
                done_qc: this.findProp(props, ['Done QC', 'done_qc']),

                // Include all properties for flexibility (already resolved in calculate)
                all_properties: props
            };
        });
    }

    /**
     * Helper to find property value case-insensitively using multiple keys
     */
    findProp(props, keys) {
        for (const key of keys) {
            if (props[key] !== undefined && props[key] !== null) return props[key];
        }
        // Case-insensitive fallback
        const lowerKeys = keys.map(k => k.toLowerCase());
        for (const [propKey, value] of Object.entries(props)) {
            if (lowerKeys.includes(propKey.toLowerCase())) return value;
        }
        return '';
    }

    // extractAssignee removed as it is now handled by generic resolveProperty and findProp

}
