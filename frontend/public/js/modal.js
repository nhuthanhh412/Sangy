/**
 * Modal Utility - Thay thế alert() và confirm() bằng modal đẹp hơn
 */

const Modal = {
    /**
     * Show alert modal
     * @param {string} message - Message to display
     * @param {string} type - Type: 'success', 'error', 'warning', 'info'
     * @param {number} duration - Auto-close after ms (0 = no auto-close)
     */
    showAlert(message, type = 'info', duration = 0) {
        const modal = this._createAlertModal(message, type);
        document.body.appendChild(modal);

        // Trigger animation
        setTimeout(() => modal.classList.add('show'), 10);

        // Auto-close for success
        if (duration > 0 || type === 'success') {
            setTimeout(() => this._closeModal(modal), duration || 3000);
        }

        return modal;
    },

    /**
     * Show confirm modal
     * @param {string} message - Message to display
     * @param {Function} onConfirm - Callback khi user click OK
     * @param {Function} onCancel - Callback khi user click Cancel (optional)
     */
    showConfirm(message, onConfirm, onCancel = null) {
        const modal = this._createConfirmModal(message, onConfirm, onCancel);
        document.body.appendChild(modal);

        // Trigger animation
        setTimeout(() => modal.classList.add('show'), 10);

        return modal;
    },

    /**
     * Create alert modal element
     */
    _createAlertModal(message, type) {
        const modal = document.createElement('div');
        modal.className = 'custom-modal-overlay';

        const icon = this._getIcon(type);
        const color = this._getColor(type);
        const title = this._getTitle(type);

        modal.innerHTML = `
            <div class="custom-modal-content" style="border-top: 4px solid ${color};">
                <div class="custom-modal-header">
                    <span style="font-size: 32px;">${icon}</span>
                    <h3 style="margin: 8px 0 0 0; color: ${color};">${title}</h3>
                </div>
                <div class="custom-modal-body">
                    <p style="margin: 0; color: #e2e8f0; white-space: pre-wrap;">${message}</p>
                </div>
                <div class="custom-modal-footer">
                    <button class="custom-modal-btn custom-modal-btn-primary" style="background: ${color};">OK</button>
                </div>
            </div>
        `;

        // Close handlers
        const btn = modal.querySelector('.custom-modal-btn-primary');
        btn.addEventListener('click', () => this._closeModal(modal));

        modal.addEventListener('click', (e) => {
            if (e.target === modal) this._closeModal(modal);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.parentNode) this._closeModal(modal);
        });

        return modal;
    },

    /**
     * Create confirm modal element
     */
    _createConfirmModal(message, onConfirm, onCancel) {
        const modal = document.createElement('div');
        modal.className = 'custom-modal-overlay';

        modal.innerHTML = `
            <div class="custom-modal-content" style="border-top: 4px solid #f59e0b;">
                <div class="custom-modal-header">
                    <span style="font-size: 32px;">⚠️</span>
                    <h3 style="margin: 8px 0 0 0; color: #f59e0b;">Xác nhận</h3>
                </div>
                <div class="custom-modal-body">
                    <p style="margin: 0; color: #e2e8f0; white-space: pre-wrap;">${message}</p>
                </div>
                <div class="custom-modal-footer" style="gap: 12px;">
                    <button class="custom-modal-btn custom-modal-btn-secondary">Hủy</button>
                    <button class="custom-modal-btn custom-modal-btn-primary" style="background: #f59e0b;">Đồng ý</button>
                </div>
            </div>
        `;

        // Button handlers
        const btnCancel = modal.querySelector('.custom-modal-btn-secondary');
        const btnConfirm = modal.querySelector('.custom-modal-btn-primary');

        btnCancel.addEventListener('click', () => {
            if (onCancel) onCancel();
            this._closeModal(modal);
        });

        btnConfirm.addEventListener('click', () => {
            if (onConfirm) onConfirm();
            this._closeModal(modal);
        });

        // ESC to cancel
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.parentNode) {
                if (onCancel) onCancel();
                this._closeModal(modal);
            }
        });

        // Click overlay to cancel
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                if (onCancel) onCancel();
                this._closeModal(modal);
            }
        });

        return modal;
    },

    /**
     * Close modal with animation
     */
    _closeModal(modal) {
        modal.classList.remove('show');
        setTimeout(() => {
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        }, 300);
    },

    /**
     * Get icon for type
     */
    _getIcon(type) {
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };
        return icons[type] || icons.info;
    },

    /**
     * Get color for type
     */
    _getColor(type) {
        const colors = {
            success: '#10b981',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };
        return colors[type] || colors.info;
    },

    /**
     * Get title for type
     */
    _getTitle(type) {
        const titles = {
            success: 'Thành công',
            error: 'Lỗi',
            warning: 'Cảnh báo',
            info: 'Thông báo'
        };
        return titles[type] || titles.info;
    }
};

// Add CSS styles
const style = document.createElement('style');
style.textContent = `
    .custom-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.3s ease;
    }
    
    .custom-modal-overlay.show {
        opacity: 1;
    }
    
    .custom-modal-content {
        background: #1e293b;
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        min-width: 400px;
        max-width: 600px;
        max-height: 80vh;
        overflow-y: auto;
        transform: scale(0.9);
        transition: transform 0.3s ease;
    }
    
    .custom-modal-overlay.show .custom-modal-content {
        transform: scale(1);
    }
    
    .custom-modal-header {
        padding: 24px 24px 16px 24px;
        text-align: center;
    }
    
    .custom-modal-body {
        padding: 0 24px 24px 24px;
        text-align: center;
    }
    
    .custom-modal-footer {
        padding: 16px 24px 24px 24px;
        display: flex;
        justify-content: center;
        align-items: center;
    }
    
    .custom-modal-btn {
        padding: 10px 24px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        min-width: 100px;
    }
    
    .custom-modal-btn-primary {
        background: #3b82f6;
        color: white;
    }
    
    .custom-modal-btn-primary:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
    }
    
    .custom-modal-btn-secondary {
        background: #475569;
        color: white;
    }
    
    .custom-modal-btn-secondary:hover {
        background: #64748b;
    }
`;
document.head.appendChild(style);

// Export to window
window.Modal = Modal;
