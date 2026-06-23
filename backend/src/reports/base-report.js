/**
 * Base Report Class
 * Abstract class for all report types
 */
export class BaseReport {
    constructor(name, description) {
        this.name = name;
        this.description = description;
    }

    /**
     * Calculate report data
     * Must be implemented by subclasses
     * @param {Object} rawData - Raw data from databases
     * @returns {Object} Calculated report data
     */
    calculate(rawData) {
        throw new Error('calculate() must be implemented by subclass');
    }

    /**
     * Format report data for frontend
     * Can be overridden by subclasses
     * @param {Object} calculatedData
     * @returns {Object} Formatted data
     */
    format(calculatedData) {
        return calculatedData;
    }

    /**
     * Validate raw data before calculation
     * Can be overridden by subclasses
     * @param {Object} rawData
     * @returns {boolean}
     */
    validate(rawData) {
        return rawData && Object.keys(rawData).length > 0;
    }

    /**
     * Generate report (main entry point)
     * @param {Object} rawData
     * @returns {Object}
     */
    async generate(rawData) {
        console.log(`[Report:${this.name}] Generating report...`);

        if (!this.validate(rawData)) {
            console.warn(`[Report:${this.name}] Validation failed`);
            return {
                success: false,
                error: 'Invalid data'
            };
        }

        try {
            const calculated = this.calculate(rawData);
            const formatted = this.format(calculated);

            console.log(`[Report:${this.name}] ✅ Generated successfully`);

            return {
                success: true,
                name: this.name,
                description: this.description,
                data: formatted,
                generated_at: new Date().toISOString()
            };
        } catch (error) {
            console.error(`[Report:${this.name}] ❌ Generation failed:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Helper: Extract property from record
     * @param {Object} record
     * @param {string} propertyName
     * @returns {any}
     */
    getProperty(record, propertyName) {
        return record.properties?.[propertyName];
    }

    /**
     * Helper: Get first person name from people property
     * @param {Array} peopleArray
     * @returns {string}
     */
    getFirstPersonName(peopleArray) {
        return peopleArray && peopleArray.length > 0 ? peopleArray[0].name : 'Unassigned';
    }
}
