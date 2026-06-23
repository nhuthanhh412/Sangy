const fs = require('fs');
const path = require('path');

function loadWhitelistIds() {
    const ids = new Set();
    try {
        const priorityPath = path.join(__dirname, 'backend', 'data', 'priority_projects.json');
        console.log('[Test] Loading whitelist from:', priorityPath);
        if (fs.existsSync(priorityPath)) {
            const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
            if (data.projects) {
                for (const proj of data.projects) {
                    ids.add(proj.id);
                }
                console.log('[Test] Loaded', ids.size, 'whitelist IDs');
                console.log('[Test] Contains 2c3ccb0e-ac88-801a-bc84-dbf6a1d4acc3?', ids.has('2c3ccb0e-ac88-801a-bc84-dbf6a1d4acc3'));
            }
        } else {
            console.warn('[Test] Whitelist file not found at:', priorityPath);
        }
    } catch (e) {
        console.warn('[Test] Could not load whitelist IDs:', e.message);
    }
    return ids;
}

loadWhitelistIds();
