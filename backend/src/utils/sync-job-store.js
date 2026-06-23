import fs from 'fs';

function sanitizeJob(job) {
    return {
        ...job,
        // Bound payload size to keep persistence small
        results: Array.isArray(job.results) ? job.results.slice(-500) : [],
        synced_databases: Array.isArray(job.synced_databases) ? job.synced_databases.slice(-500) : []
    };
}

export function loadSyncJobs(filePath) {
    try {
        if (!fs.existsSync(filePath)) return new Map();
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw) return new Map();

        const parsed = JSON.parse(raw);
        const jobs = new Map();
        Object.entries(parsed).forEach(([jobId, job]) => {
            // Recover incomplete jobs as interrupted after restart
            if (job.status === 'running' || job.status === 'starting') {
                job.status = 'error';
                job.error = 'Server restarted during sync job';
            }
            jobs.set(jobId, job);
        });
        return jobs;
    } catch (error) {
        console.error('[SyncJobs] Failed to load persisted jobs:', error.message);
        return new Map();
    }
}

export function persistSyncJobs(filePath, jobsMap) {
    try {
        const payload = {};
        jobsMap.forEach((job, jobId) => {
            payload[jobId] = sanitizeJob(job);
        });
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error('[SyncJobs] Failed to persist jobs:', error.message);
    }
}

