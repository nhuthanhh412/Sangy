import { SprintReport } from './sprint-report.js';
import { ProductivityReport } from './productivity-report.js';
import { RawTasksReport } from './raw-tasks-report.js';

/**
 * Report Registry
 * Central registry for all available reports
 */
class ReportRegistry {
    constructor() {
        this.reports = new Map();
        this.registerDefaultReports();
    }

    /**
     * Register default reports
     */
    registerDefaultReports() {
        this.register(new SprintReport());
        this.register(new ProductivityReport());
    }

    /**
     * Register a new report
     * @param {BaseReport} report
     */
    register(report) {
        this.reports.set(report.name, report);
        console.log(`[ReportRegistry] Registered report: ${report.name}`);
    }

    /**
     * Get a specific report by name
     * @param {string} reportName
     * @returns {BaseReport}
     */
    getReport(reportName) {
        return this.reports.get(reportName);
    }

    /**
     * Get all available reports
     * @returns {Array}
     */
    getAllReports() {
        return Array.from(this.reports.values()).map(report => ({
            name: report.name,
            description: report.description
        }));
    }

    /**
     * Generate a specific report
     * @param {string} reportName
     * @param {Object} rawData
     * @returns {Promise<Object>}
     */
    async generateReport(reportName, rawData) {
        const report = this.getReport(reportName);

        if (!report) {
            return {
                success: false,
                error: `Report '${reportName}' not found`
            };
        }

        return await report.generate(rawData);
    }
}

// Export singleton instance
export const reportRegistry = new ReportRegistry();
