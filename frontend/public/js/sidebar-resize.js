// sidebar-resize.js - Handle sidebar resizing
(function () {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    document.addEventListener('DOMContentLoaded', () => {
        const sidebar = document.querySelector('.sidebar');
        const handle = document.querySelector('.sidebar-resize-handle');

        if (!sidebar || !handle) return;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            // Use getComputedStyle for accurate width including padding/border if any
            startWidth = parseInt(window.getComputedStyle(sidebar).width, 10);

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const diff = e.clientX - startX;
            const newWidth = startWidth + diff;

            const minWidth = 250;
            const maxWidth = window.innerWidth * 0.5;

            if (newWidth >= minWidth && newWidth <= maxWidth) {
                sidebar.style.width = newWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        // Mobile menu toggle functionality
        const mobileToggle = document.getElementById('mobile-menu-toggle');
        const mobileOverlay = document.getElementById('mobile-overlay');

        // SVG icons for mobile menu toggle
        const menuIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M3 12h18M3 6h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
        const closeIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;

        if (mobileToggle && mobileOverlay) {
            mobileToggle.addEventListener('click', () => {
                sidebar.classList.toggle('open');
                mobileOverlay.classList.toggle('active');
                mobileToggle.innerHTML = sidebar.classList.contains('open') ? closeIcon : menuIcon;
            });

            mobileOverlay.addEventListener('click', () => {
                sidebar.classList.remove('open');
                mobileOverlay.classList.remove('active');
                mobileToggle.innerHTML = menuIcon;
            });

            // Close sidebar when clicking on a database item on mobile
            sidebar.addEventListener('click', (e) => {
                if (window.innerWidth <= 768) {
                    if (e.target.closest('.database-item') ||
                        (e.target.type === 'checkbox' && e.target.dataset.dbId)) {
                        setTimeout(() => {
                            sidebar.classList.remove('open');
                            mobileOverlay.classList.remove('active');
                            mobileToggle.innerHTML = menuIcon;
                        }, 300);
                    }
                }
            });
        }
    });
})();
