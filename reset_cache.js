const fs = require('fs');
const path = require('path');
const p = path.join('backend', 'data', 'config.json');
try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.projects_tree_cache_time = 0;
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
    console.log('Cache time reset to 0');
} catch (e) {
    console.error(e);
}
