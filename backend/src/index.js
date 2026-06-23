import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { createServer } from 'http';
import crypto from 'crypto';
import compression from 'compression';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: join(__dirname, '../.env') });

import { setupRoutes } from './api/routes.js';
import { RealtimeServer } from './websocket/server.js';
import { PollingService } from './scheduler/poller.js';
import { getDbInstance } from './database/db.js';

/**
 * Main Application Entry Point
 */
class NotionDashboardServer {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.db = getDbInstance(); // Use singleton
        this.accessToken = null; // Will be set via session
    }

    /**
     * Initialize the server
     */
    async init() {
        console.log('🚀 Starting Notion Dashboard Server...');

        // Create HTTP server
        this.server = createServer(this.app);

        // Setup middleware FIRST
        const corsOrigin = process.env.CORS_ORIGIN || `http://localhost:${this.port}`;
        this.app.use(cors({
            origin: corsOrigin,
            credentials: true
        }));

        // Generate secure session secret if default placeholder is still in use
        let sessionSecret = process.env.SESSION_SECRET;
        const isDefaultSecret = !sessionSecret || sessionSecret.includes('change-this');
        if (isDefaultSecret) {
            sessionSecret = crypto.randomBytes(64).toString('hex');
            console.warn('[Server] ⚠️ SESSION_SECRET is using default placeholder! Generated random secret for this session.');
            console.warn('[Server] ⚠️ Set a strong SESSION_SECRET in .env for production.');
        }

        this.app.use(session({
            secret: sessionSecret,
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: false,
                maxAge: 24 * 60 * 60 * 1000
            }
        }));

        // Gzip/Brotli compression for all responses
        this.app.use(compression());

        this.app.use(express.json());

        // Setup WebSocket server
        this.wsServer = new RealtimeServer(this.server);

        // Setup polling service (5 minutes default)
        const pollingInterval = parseInt(process.env.POLLING_INTERVAL) || 300000;
        this.poller = new PollingService(
            this.db,
            this.wsServer,
            () => this.getAccessToken()
        );

        // Setup API routes (Now passing poller)
        setupRoutes(this.app, this.db, this.poller);

        // Serve frontend static files LAST (after API routes)
        const frontendPath = join(__dirname, '..', '..', 'frontend', 'public');
        this.app.use(express.static(frontendPath));
        console.log('[Server] Serving frontend from:', frontendPath);

        // Show cache stats before starting
        const cacheStats = this.db.getStats();
        console.log(`[Server] 📦 Cache ready: ${cacheStats.databases} databases, ${cacheStats.totalRecords} records`);
        if (cacheStats.lastRefresh) {
            console.log(`[Server] 📅 Last sync: ${new Date(cacheStats.lastRefresh).toLocaleString()}`);
        }

        // Start polling (delayed - cache available immediately)
        this.poller.start(pollingInterval);

        // Graceful shutdown handling
        this.setupShutdownHandlers();

        // Start server
        this.server.listen(this.port, () => {
            console.log('');
            console.log(' Chào mừng đến với DashNotion!');
            console.log(`📡 Truy cập localhost: http://localhost:${this.port}`);
            console.log('');
        });
    }

    /**
     * Get current access token from session store
     * Note: In a real implementation, you'd need a proper session store
     * This is a simplified version
     */
    getAccessToken() {
        // For now, get from config (will be saved after OAuth)
        return this.db.getConfig('access_token');
    }

    /**
     * Setup graceful shutdown handlers
     */
    setupShutdownHandlers() {
        const shutdown = () => {
            console.log('\\n🛑 Shutting down gracefully...');

            // Stop polling
            if (this.poller) {
                this.poller.stop();
            }

            // Close WebSocket server
            if (this.wsServer) {
                this.wsServer.close();
            }

            // Close database
            if (this.db) {
                this.db.close();
            }

            // Close HTTP server
            if (this.server) {
                this.server.close(() => {
                    console.log('✅ Server closed');
                    process.exit(0);
                });
            }
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }
}

// Start the server
const server = new NotionDashboardServer();
server.init().catch((error) => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
});
