import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function debugLog(message) {
    const logPath = join(__dirname, '..', 'debug_refresh.log');
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    try {
        appendFileSync(logPath, logMessage);
    } catch (err) {
        console.error('Failed to write debug log:', err);
    }
}

export default debugLog;
