/**
 * UI components for Sync and Freshness
 */

export function setupSyncNotifications() {
    const toast = document.getElementById('sync-progress-toast');
    const toastMessage = document.getElementById('sync-toast-message');
    const toastProgress = document.getElementById('sync-toast-progress');
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    window.addEventListener('sync-update', (event) => {
        const data = event.detail;

        if (data.type === 'connection') {
            if (data.status === 'connected') {
                if (statusDot) statusDot.style.background = 'var(--color-success)';
                if (statusText) statusText.textContent = 'Đã kết nối';
            } else if (data.status === 'disconnected') {
                if (statusDot) statusDot.style.background = 'var(--color-warning)';
                if (statusText) statusText.textContent = 'Mất kết nối...';
            } else if (data.status === 'failed') {
                if (statusDot) statusDot.style.background = 'var(--color-error)';
                if (statusText) statusText.textContent = 'Lỗi kết nối';
            }
            return;
        }

        if (data.type === 'progress') {
            toast.classList.remove('hidden');
            toastMessage.textContent = data.message;
            if (data.progress) {
                toastProgress.style.width = `${data.progress}%`;
            } else {
                // Determine progress based on message or unknown
                toastProgress.style.width = '50%';
            }
        } else if (data.type === 'complete') {
            toastMessage.textContent = 'Đồng bộ hoàn tất!';
            toastProgress.style.width = '100%';
            setTimeout(() => {
                toast.classList.add('hidden');
                // Refresh active report if needed
                if (window.app && window.app.refreshActiveReport) {
                    window.app.refreshActiveReport();
                }
            }, 3000);
        } else if (data.type === 'error') {
            toastMessage.textContent = `Lỗi: ${data.message}`;
            toastProgress.style.backgroundColor = 'var(--color-error)';
            setTimeout(() => {
                toast.classList.add('hidden');
            }, 5000);
        }
    });
}

/**
 * Render Freshness Badge
 */
export function renderFreshnessBadge(meta) {
    if (!meta) return '';

    const statusClass = meta.status === 'fresh' ? 'fresh' : (meta.status === 'cached' ? 'cached' : 'stale');
    const statusText = meta.status === 'fresh' ? 'MỚI' : (meta.status === 'cached' ? 'CŨ' : 'LỖI');
    const timeText = meta.synced_at ? new Date(meta.synced_at).toLocaleTimeString() : '---';

    return `
        <div class="freshness-badge ${statusClass}" title="Nguồn: ${meta.source || 'unknown'} - Đồng bộ lúc: ${timeText}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                <path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            ${statusText} (${timeText})
        </div>
    `;
}
