import { BaseReport } from './base-report.js';

/**
 * Productivity Report
 * Calculates productivity metrics by assignee
 */
export class ProductivityReport extends BaseReport {
    constructor() {
        super('productivity', 'Báo Cáo Năng Suất');
    }

    calculate(rawData) {
        const allRecords = Object.values(rawData).flat();

        const grouped = {};

        for (const record of allRecords) {
            // Extract assignee
            const assignees = this.getProperty(record, 'Assignee') ||
                this.getProperty(record, 'assignee') ||
                this.getProperty(record, 'Người làm') || [];
            const assignee = this.getFirstPersonName(assignees);

            // Extract actual hours
            const actualHours = parseFloat(this.getProperty(record, 'Số công thực tế') ||
                this.getProperty(record, 'actual_hours') ||
                this.getProperty(record, 'Thực tế') ||
                this.getProperty(record, 'Actual Hours')) || 0;

            // Extract expected hours (from requirements or other field)
            const expectedHours = parseFloat(this.getProperty(record, 'Số công yêu cầu') ||
                this.getProperty(record, 'expected_hours') ||
                this.getProperty(record, 'Expected Hours') ||
                this.getProperty(record, 'Yêu cầu') ||
                this.getProperty(record, 'Task point') || // Fallback if no specific hours
                this.getProperty(record, 'Task point yêu cầu dự án')) || 0;

            // Extract task points
            const points = parseFloat(this.getProperty(record, 'Task point') ||
                this.getProperty(record, 'task_point') ||
                this.getProperty(record, 'Point') ||
                this.getProperty(record, 'Năng xuất thực tế - confirmed point') ||
                this.getProperty(record, 'Points')) || 0;

            // Initialize assignee group
            if (!grouped[assignee]) {
                grouped[assignee] = {
                    total_actual_hours: 0,
                    total_expected_hours: 0,
                    total_points: 0,
                    task_count: 0
                };
            }

            grouped[assignee].total_actual_hours += actualHours;
            grouped[assignee].total_expected_hours += expectedHours;
            grouped[assignee].total_points += points;
            grouped[assignee].task_count += 1;
        }

        return grouped;
    }

    format(calculatedData) {
        const result = [];

        for (const [assignee, metrics] of Object.entries(calculatedData)) {
            const productivity = metrics.total_expected_hours > 0
                ? (metrics.total_actual_hours / metrics.total_expected_hours) * 100
                : 0;

            result.push({
                assignee,
                total_actual_hours: metrics.total_actual_hours,
                total_expected_hours: metrics.total_expected_hours,
                total_points: metrics.total_points,
                task_count: metrics.task_count,
                productivity_percentage: Math.round(productivity * 100) / 100 // Round to 2 decimals
            });
        }

        // Sort by productivity percentage descending
        result.sort((a, b) => b.productivity_percentage - a.productivity_percentage);

        return result;
    }
}
