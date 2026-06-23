import { WebSocketServer } from 'ws';

/**
 * WebSocket Server for real-time updates
 */
export class RealtimeServer {
    constructor(server) {
        this.wss = new WebSocketServer({ server });
        this.clients = new Set();
        this.setupEventHandlers();

        console.log('[WebSocket] Server initialized');
    }

    /**
     * Setup WebSocket event handlers
     */
    setupEventHandlers() {
        this.wss.on('connection', (ws) => {
            console.log('[WebSocket] Client connected');
            this.clients.add(ws);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to Notion Dashboard WebSocket',
                timestamp: new Date().toISOString()
            }));

            // Heartbeat
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });

            // Handle messages from client
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    console.log('[WebSocket] Received:', data);

                    // Handle ping
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
                    }
                } catch (error) {
                    console.error('[WebSocket] Error parsing message:', error);
                }
            });

            // Handle disconnect
            ws.on('close', () => {
                console.log('[WebSocket] Client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('[WebSocket] Error:', error);
                this.clients.delete(ws);
            });
        });

        // Heartbeat interval to detect dead connections
        this.heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    this.clients.delete(ws);
                    return ws.terminate();
                }

                ws.isAlive = false;
                ws.ping();
            });
        }, 30000); // Every 30 seconds
    }

    /**
     * Broadcast data update to all connected clients
     * @param {Object} data - Data to broadcast
     */
    broadcastUpdate(data) {
        const message = JSON.stringify({
            type: 'data-updated',
            timestamp: new Date().toISOString(),
            ...data
        });

        let sentCount = 0;
        this.clients.forEach((ws) => {
            if (ws.readyState === 1) { // OPEN
                ws.send(message);
                sentCount++;
            }
        });

        console.log(`[WebSocket] Broadcast update to ${sentCount} clients`);
    }

    /**
     * Send message to specific client
     * @param {WebSocket} ws
     * @param {Object} data
     */
    sendToClient(ws, data) {
        if (ws.readyState === 1) { // OPEN
            ws.send(JSON.stringify({
                timestamp: new Date().toISOString(),
                ...data
            }));
        }
    }

    /**
     * Get number of connected clients
     * @returns {number}
     */
    getClientCount() {
        return this.clients.size;
    }

    /**
     * Close WebSocket server
     */
    close() {
        clearInterval(this.heartbeatInterval);
        this.wss.close();
        console.log('[WebSocket] Server closed');
    }
}
