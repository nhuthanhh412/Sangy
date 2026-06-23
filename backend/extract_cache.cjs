const fs = require('fs');
const path = require('path');

const cachePath = path.join(__dirname, 'data/cache.json');
const priorityPath = path.join(__dirname, 'data/priority_projects.json');
const outPath = path.join(__dirname, '../frontend/public/data/tasks_snapshot.json');

console.log('Reading cache...');
const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
const priorityData = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));

const records = [];
let totalExtracted = 0;

for (const project of priorityData.projects) {
    for (const db of (project.databases || [])) {
        if (db.type === 'tasks') {
            const dbData = cacheData.data_cache[db.id];
            if (dbData && Array.isArray(dbData)) {
                console.log(`Extracted ${dbData.length} from ${db.name}`);
                for (const row of dbData) {
                    records.push({
                        ...row,
                        database_id: db.id,
                        database_name: db.name,
                        project_name: project.name,
                        project_code: project.code
                    });
                }
                totalExtracted += dbData.length;
            } else {
                console.log(`No data in cache for ${db.name} (${db.id})`);
            }
        }
    }
}

fs.mkdirSync(path.dirname(outPath), {recursive: true});
fs.writeFileSync(outPath, JSON.stringify({ records: records }), 'utf8');
console.log('Successfully wrote ' + totalExtracted + ' records to ' + outPath);
