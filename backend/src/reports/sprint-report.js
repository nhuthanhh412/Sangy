import { BaseReport } from './base-report.js';
import fs from 'fs';

/**
 * Sprint Report
 * Calculates task points by sprint and assignee
 */
export class SprintReport extends BaseReport {
    constructor() {
        super('sprint', 'Báo Cáo Sprint');
    }

    calculate(rawData) {
        // Flatten all records from all databases
        const allRecords = Object.values(rawData).flat();

        // 1. Build ID -> Name Map to resolve Relations
        const idToNameMap = new Map();
        let mappedCount = 0;

        for (const record of allRecords) {
            if (!record.properties) continue;

            // Smart Title Detection
            let name = this.getProperty(record, 'Name') ||
                this.getProperty(record, 'Title') ||
                this.getProperty(record, 'Tên') ||
                this.getProperty(record, 'Tên task');

            if (!name) {
                const lowerProps = Object.keys(record.properties).reduce((acc, key) => {
                    acc[key.toLowerCase()] = record.properties[key];
                    return acc;
                }, {});

                name = lowerProps['name'] ||
                    lowerProps['title'] ||
                    lowerProps['sprint name'] ||
                    lowerProps['product name'] ||
                    lowerProps['tên'];
            }

            if (name) {
                idToNameMap.set(record.id, name);
                mappedCount++;
            }
        }

        console.log(`[SprintReport] Mapped ${mappedCount} items for name resolution`);

        const grouped = {};

        for (const record of allRecords) {
            // Extract Project
            let project = record.project_name || record.database_name || 'Unknown Project';

            // Extract Product - support generic and specific names
            let product = this.resolveValue(record, ['Product', 'Sản phẩm', 'Product Name', 'Tên sản phẩm'], idToNameMap) || 'No Product';

            // Extract Sprint
            let sprint = this.resolveValue(record, ['Sprint', 'Đợt', 'Sprint Name', 'Tên Sprint'], idToNameMap) || 'No Sprint';

            // Extract Assignee
            let assignee = this.extractAssigneeName(record);

            // Extract Task Points - Priority: Calculated Confired > Request Point > Generic Point
            // Based on user cache structure: "Task point yêu cầu dự án", "Task point thực tế confirmed"

            // Check for pre-calculated confirmed/unconfirmed points first (from cache analysis)
            const preCalConf = parseFloat(this.getProperty(record, 'Task point thực tế confirmed') ||
                this.getProperty(record, 'Năng xuất thực tế - confirmed point')) || 0;

            const preCalUnconf = parseFloat(this.getProperty(record, 'Task point thực tế unconfirmed') ||
                this.getProperty(record, 'Năng xuất thực tế - unconfirmed point')) || 0;

            // Generic/Request points
            const requestPoints = parseFloat(this.getProperty(record, 'Task point') ||
                this.getProperty(record, 'task_point') ||
                this.getProperty(record, 'Task point yêu cầu dự án') ||
                this.getProperty(record, 'Point') ||
                this.getProperty(record, 'Points') ||
                this.getProperty(record, 'Product point')) || 0;

            // Extract Status
            const status = this.getProperty(record, 'Status') ||
                this.getProperty(record, 'status') ||
                this.getProperty(record, 'Trạng thái') || '';

            const isConfirmedStatus = status.toLowerCase().includes('done') ||
                status.toLowerCase().includes('ok') ||
                status.toLowerCase().includes('confirmed') ||
                status.toLowerCase().includes('approved') ||
                status.toLowerCase().includes('hoàn thành') ||
                status.toLowerCase().includes('đạt');

            // Logic: If pre-calculated points exist, use them. Otherwise calculate based on status and request points.
            let confirmed = 0;
            let unconfirmed = 0;
            let total = 0;

            if (preCalConf > 0 || preCalUnconf > 0) {
                confirmed = preCalConf;
                unconfirmed = preCalUnconf;
                total = confirmed + unconfirmed;
            } else {
                // Fallback to manual calculation
                confirmed = isConfirmedStatus ? requestPoints : 0;
                unconfirmed = isConfirmedStatus ? 0 : requestPoints;
                total = requestPoints;
            }

            // Grouping Structure: grouped[project][sprint][assignee]
            if (!grouped[project]) grouped[project] = {};
            if (!grouped[project][sprint]) grouped[project][sprint] = {};

            if (!grouped[project][sprint][assignee]) {
                grouped[project][sprint][assignee] = {
                    confirmed: 0,
                    unconfirmed: 0,
                    total: 0,
                    products: new Set()
                };
            }

            // Track products
            if (product !== 'No Product') {
                grouped[project][sprint][assignee].products.add(product);
            }

            grouped[project][sprint][assignee].confirmed += confirmed;
            grouped[project][sprint][assignee].unconfirmed += unconfirmed;
            grouped[project][sprint][assignee].total += total;
        }

        return grouped;
    }

    /**
     * Helper to resolve property value, handling Selects and Relations (via Map)
     */
    resolveValue(record, keys, idToNameMap) {
        for (const key of keys) {
            const val = this.getProperty(record, key);
            if (!val) continue;

            // If array (Relation or Multi-select)
            if (Array.isArray(val)) {
                if (val.length === 0) continue;
                // Try to map IDs to Names if they look like IDs (uuid validation or just check map)
                const mapped = val.map(item => {
                    // Item could be a string ID (Relation) or string Name (Multi-select from fetcher)
                    // Fetcher returns IDs for relations.
                    if (idToNameMap.has(item)) return idToNameMap.get(item);
                    return item; // Assume it's already a name if not in map
                });
                return mapped.join(', ');
            }

            // If single value
            if (idToNameMap.has(val)) return idToNameMap.get(val);
            return val;
        }
        return null;
    }

    extractAssigneeName(record) {
        const people = this.getProperty(record, 'Assignee') ||
            this.getProperty(record, 'assignee') ||
            this.getProperty(record, 'Owner') || // Added Owner
            this.getProperty(record, 'Người làm') ||
            this.getProperty(record, 'Người thực hiện');

        return this.getFirstPersonName(people);
    }

    format(calculatedData) {
        // Flatten for frontend: [{ project, sprint, assignee, confirmed_points, ... }]
        const result = [];

        for (const [project, sprints] of Object.entries(calculatedData)) {
            for (const [sprint, assignees] of Object.entries(sprints)) {
                for (const [assignee, stats] of Object.entries(assignees)) {
                    // Filter out rows with 0 points if desired, but user might want to see them.
                    // Let's keep them if they exist in the grouping.
                    if (stats.total === 0) continue;

                    result.push({
                        project,
                        sprint,
                        assignee,
                        product: Array.from(stats.products).join(', '),
                        confirmed_points: stats.confirmed,
                        unconfirmed_points: stats.unconfirmed,
                        total_points: stats.total
                    });
                }
            }
        }

        // Sort: Project -> Sprint -> Assignee
        result.sort((a, b) => {
            if (a.project !== b.project) return a.project.localeCompare(b.project);
            if (a.sprint !== b.sprint) return a.sprint.localeCompare(b.sprint);
            return a.assignee.localeCompare(b.assignee);
        });

        // Limit to 1000 rows to prevent browser freeze
        if (result.length > 1000) {
            console.warn(`[SprintReport] Data too large (${result.length} rows), limiting to 1000`);
            return result.slice(0, 1000);
        }

        return result;
    }
}
