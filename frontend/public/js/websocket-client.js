/**
 * WebSocket Client for Dash Notion
 * Handles real-time sync progress updates from the backend
 */
export class WebSocketClient {
    constructor() {
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
        this.listeners = new Set();
        this.isConnecting = false;
    }

    /**
     * Initialize connection
     */
    connect() {
        if (this.socket || this.isConnecting) return;
        this.isConnecting = true;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}`;

        console.log(`[WS] Connecting to ${wsUrl}...`);

        try {
            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                console.log('[WS] Connected to server');
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.notify({ type: 'connection', status: 'connected' });
            };

            this.socket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    console.log('[WS] Message received:', data);
                    this.notify(data);
                } catch (e) {
                    console.error('[WS] Error parsing message:', e);
                }
            };

            this.socket.onclose = () => {
                console.warn('[WS] Connection closed');
                this.socket = null;
                this.isConnecting = false;
                this.notify({ type: 'connection', status: 'disconnected' });
                this.attemptReconnect();
            };

            this.socket.onerror = (error) => {
                console.error('[WS] Socket error:', error);
                this.isConnecting = false;
            };
        } catch (e) {
            console.error('[WS] Connection failed:', e);
            this.isConnecting = false;
            this.attemptReconnect();
        }
    }

    /**
     * Retry connection with exponential backoff
     */
    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`[WS] Reconnecting in ${this.reconnectDelay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay *= 2; // Exponential backoff
        } else {
            console.error('[WS] Max reconnect attempts reached');
            this.notify({ type: 'connection', status: 'failed' });
        }
    }

    /**
     * Add event listener
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * Remove event listener
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * Notify all listeners
     */
    notify(data) {
        this.listeners.forEach(callback => {
            try {
                callback(data);
            } catch (e) {
                console.error('[WS] Listener error:', e);
            }
        });

        // Dispatch custom global event for easier integration
        const event = new CustomEvent('sync-update', { detail: data });
        window.dispatchEvent(event);
    }
}

// Export singleton instance
export const wsClient = new WebSocketClient();
