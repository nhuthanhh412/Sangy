// auth.js - Simplified authentication for Internal Integration Token
const API_BASE = window.location.origin;

class AuthManager {
    constructor() {
        this.init();
    }

    async init() {
        const status = await this.checkStatus();
        const tokenConfigured = !!status.configured;
        const sessionAuthenticated = !!status.session_authenticated;

        console.log(`[Auth] token_configured=${tokenConfigured}, session_authenticated=${sessionAuthenticated}`);

        if (tokenConfigured) {
            this.showDashboard();
        } else {
            this.showAuthScreen();
        }
    }

    async autoSelectAllDatabases() {
        try {
            // Fetch all available databases
            const response = await fetch(`${API_BASE}/api/databases`, {
                credentials: 'include'
            });
            const data = await response.json();

            if (data.success && data.databases && data.databases.length > 0) {
                // Select all databases
                const allDbIds = data.databases.map(db => db.id);

                await fetch(`${API_BASE}/api/databases/select`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ database_ids: allDbIds })
                });

                console.log(`[Auth] ✅ Auto-selected ${allDbIds.length} databases`);
            }
        } catch (error) {
            console.error('[Auth] Error auto-selecting databases:', error);
        }
    }

    async checkDatabases() {
        try {
            const response = await fetch(`${API_BASE}/api/databases/selected`, {
                credentials: 'include'
            });
            const data = await response.json();
            return data.success && data.databases && data.databases.length > 0;
        } catch (error) {
            console.error('Error checking databases:', error);
            return false;
        }
    }

    async checkStatus() {
        try {
            const response = await fetch(`${API_BASE}/auth/status`, {
                credentials: 'include'
            });
            return await response.json();
        } catch (error) {
            console.error('Error checking auth status:', error);
            return { authenticated: false };
        }
    }

    showAuthScreen() {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');

        const statusContainer = document.getElementById('auth-status');
        if (statusContainer) {
            statusContainer.innerHTML = `
                <div style="padding: 1rem; background: #dc2626; color: white; border-radius: 8px; text-align: center;">
                    <svg style="display: inline; margin-right: 0.5rem;" width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M12 5v7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                        <path d="M12 14v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
                    </svg>
                    <strong>⚠️ Lỗi kết nối backend</strong>
                    <p style="font-size: 0.9rem; margin-top: 0.5rem;">Backend không phản hồi. Vui lòng:</p>
                    <ul style="text-align: left; display: inline-block; margin-top: 0.5rem;">
                        <li>1. Kiểm tra backend đã khởi động: <code>cd backend && npm start</code></li>
                        <li>2. Kiểm tra <code>backend/.env</code> có <code>NOTION_ACCESS_TOKEN</code></li>
                        <li>3. Trang web chạy ở port 3000, backend cũng chạy port 3000</li>
                    </ul>
                </div>
            `;
        }
    }

    showSetup() {
        console.log('[Auth] Showing setup screen');
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('setup').classList.remove('hidden');

        // Initialize setup wizard
        if (!window.setupWizard) {
            console.log('[Auth] Creating new SetupWizard instance');
            window.setupWizard = new SetupWizard();
        }
        window.setupWizard.init();
    }

    showDashboard() {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('setup').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');

        // Initialize dashboard
        // Use 'window.app' to match the variable name used in HTML onclick handlers
        if (window.app) {
            window.app.init();
        } else if (window.DashboardApp) {
            window.app = new window.DashboardApp();
            window.app.init();
        } else {
            // app.js module hasn't loaded yet, wait for it
            console.log('[Auth] Waiting for DashboardApp to load...');
            const waitForApp = setInterval(() => {
                if (window.DashboardApp) {
                    clearInterval(waitForApp);
                    window.app = new window.DashboardApp();
                    window.app.init();
                    console.log('[Auth] ✅ DashboardApp loaded and initialized');
                }
            }, 100);
            // Timeout after 10s
            setTimeout(() => {
                clearInterval(waitForApp);
                console.error('[Auth] DashboardApp failed to load within 10 seconds');
            }, 10000);
        }
    }

    async logout() {
        try {
            await fetch(`${API_BASE}/auth/logout`, {
                method: 'POST',
                credentials: 'include'
            });

            window.location.href = '/';
        } catch (error) {
            console.error('Logout error:', error);
        }
    }
}

// Initialize auth manager
window.auth = new AuthManager();
