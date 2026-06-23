const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'data', 'cache');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(data) || data.length === 0) continue;
    const keys = Object.keys(data[0].properties || {});
    const hasAssign = keys.some(k => k.toLowerCase().includes('assign'));
    if (hasAssign) {
        console.log('=== File:', f, '===');
        console.log('Top-level keys:', Object.keys(data[0]).join(', '));
        console.log('Property keys:', keys.join(', '));
        console.log('Sample record (first):', JSON.stringify(data[0], null, 2).substring(0, 600));
        break;
    }
}
