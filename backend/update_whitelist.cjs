const fs = require('fs');
const path = require('path');

try {
    const scanResults = JSON.parse(fs.readFileSync('scan_results.json', 'utf8'));
    const priorityPath = path.join('data', 'priority_projects.json');
    const priorityConfig = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));

    // List all DB IDs for Fetcher priority
    let allPriorityDbIds = [];

    // Process all projects
    priorityConfig.projects.forEach(p => {
        // If results exist in scan, use them
        if (scanResults[p.id]) {
            p.databases = scanResults[p.id];
        }

        // Collect IDs for priority list
        if (p.databases) {
            p.databases.forEach(db => allPriorityDbIds.push(db.id));
        }
    });

    priorityConfig.priority_databases = [...new Set(allPriorityDbIds)]; // Remove duplicates

    fs.writeFileSync(priorityPath, JSON.stringify(priorityConfig, null, 2));
    console.log(`Updated priority_projects.json with ${allPriorityDbIds.length} priority DBs`);
} catch (e) {
    console.error(e);
}
