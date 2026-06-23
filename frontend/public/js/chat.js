const CHAT_API_BASE = window.location.origin;

const SUGGESTED_QUESTIONS = [
    { icon: '📊', text: 'Tổng quan task tuần này' },
    { icon: '🔥', text: 'Ai có nhiều task nhất?' },
    { icon: '⏰', text: 'Task sắp deadline 3 ngày tới' },
    { icon: '❌', text: 'Task chưa hoàn thành tháng này' },
    { icon: '⚠️', text: 'Task quá hạn' },
    { icon: '👥', text: 'Workload point từng member tuần này' },
    { icon: '🏆', text: 'Năng suất cao nhất tuần trước' },
    { icon: '✅', text: 'Số task confirmed tháng này' },
    { icon: '🐛', text: 'Task loại Bug tuần này' },
    { icon: '😎', text: 'Ai rảnh nhất tuần này?' },
];

// Full catalog of questions grouped by category
const QUESTION_CATALOG = [
    {
        category: '📊 Tổng quan',
        items: [
            'Tổng quan task hôm nay',
            'Tổng quan task hôm qua',
            'Tổng quan task tuần này',
            'Tổng quan task tuần trước',
            'Tổng quan task tháng này',
            'Tổng quan task tháng trước',
            'Tình hình task chung',
            'Tỷ lệ hoàn thành của team',
            'Những dự án đang chạy (AI)',
            'Xu hướng workload 4 tuần'
        ]
    },
    {
        category: '👤 Theo người',
        items: [
            'Ai có nhiều task nhất?',
            'Ai đang ôm nhiều việc nhất?',
            'Ai rảnh nhất tuần này?',
            'Ai ít task nhất?',
            'Ai chưa có task tuần này?',
            'Ai không có việc gì làm?',
            'Ai đang bị quá tải?',
            'Thành viên nào năng suất nhất? (AI)',
            'Người có tỷ lệ Done cao nhất',
            'Ai chưa Done QC task nào?',
            'Workload point từng member',
            'Effort từng member'
        ]
    },
    {
        category: '⏰ Deadline & Tiến độ',
        items: [
            'Task sắp deadline trong 3 ngày tới',
            'Task cần hoàn thành gấp',
            'Task quá hạn (Overdue)',
            'Ai có nhiều task quá hạn nhất?',
            'Task chưa hoàn thành tháng này',
            'Những task còn tồn đọng',
            'Task In Progress quá 5 ngày',
            'Task nào đang bị delay?',
            'Task chưa assign',
            'Task sắp đến hạn hôm nay',
            'Danh sách task của admin'
        ]
    },
    {
        category: '📈 Điểm & Năng suất',
        items: [
            'Năng suất cao nhất tuần qua',
            'Ai cầy được nhiều point nhất?',
            'Workload point từng member tuần này',
            'Tổng điểm thực tế tháng này (AI)',
            'Số task confirmed tháng này',
            'Ai đã được confirm point?',
            'Số task unconfirmed tuần qua',
            'So sánh confirmed vs unconfirmed',
            'Năng suất hôm nay thế nào? (AI)',
            'Ai có hiệu suất tăng trưởng?'
        ]
    },
    {
        category: '🔧 Dự án & Loại task',
        items: [
            'Task loại Bug tuần này',
            'Có bao nhiêu bug chưa fix?',
            'Phân bổ theo loại task (Bug/Task/Imp)',
            'Dự án nào tốn nhiều effort nhất?',
            'Tổng nỗ lực thực tế tuần này (AI)',
            'Task tốn nhiều thời gian nhất',
            'Task effort > 3 ngày công',
            'Thống kê theo Sprint hiện tại',
            'So sánh workload giữa các dự án (AI)'
        ]
    },
    {
        category: '📋 Theo trạng thái',
        items: [
            'Có bao nhiêu task In Progress?',
            'Danh sách các task Done QC',
            'Task đang chờ xử lý (Pending)',
            'Task mới nhận (Not Started)',
            'Tiến độ các task In Progress',
            'Task xong nhưng chưa QC',
            'Task bị lùi lịch (Backlog)'
        ]
    }
];

const FOLLOW_UP_MAP = {
    'nhieu task': [
        { text: 'Workload point từng member' },
        { text: 'Ai đang bị quá tải?' },
        { text: 'Task chưa hoàn thành' },
    ],
    'chua hoan thanh': [
        { text: 'Task quá hạn' },
        { text: 'Task sắp deadline 3 ngày tới' },
        { text: 'Tỷ lệ hoàn thành tháng này' },
    ],
    'qua han': [
        { text: 'Task In Progress quá 5 ngày' },
        { text: 'Ai có nhiều task quá hạn nhất?' },
        { text: 'Tổng quan task' },
    ],
    'deadline': [
        { text: 'Task quá hạn' },
        { text: 'Task chưa hoàn thành' },
        { text: 'Tổng quan task tuần này' },
    ],
    'workload': [
        { text: 'Ai đang bị quá tải?' },
        { text: 'So sánh confirmed vs unconfirmed' },
        { text: 'Dự án nào tốn effort nhất?' },
    ],
    'nang suat': [
        { text: 'So sánh confirmed vs unconfirmed' },
        { text: 'Xu hướng workload 4 tuần' },
        { text: 'Tỷ lệ hoàn thành tháng này' },
    ],
    'sprint': [
        { text: 'Tỷ lệ hoàn thành tháng này' },
        { text: 'Năng suất cao nhất tuần này' },
        { text: 'Task chưa hoàn thành' },
    ],
    'effort': [
        { text: 'Dự án nào tốn effort nhất?' },
        { text: 'Workload point từng member' },
        { text: 'Task effort lớn hơn 3 ngày' },
    ],
    'default': [
        { text: 'Tổng quan task' },
        { text: 'Task quá hạn' },
        { text: 'Ai có nhiều task nhất?' },
    ]
};

class ChatPreviewWidget {
    constructor() {
        this.enabled = false;
        this.history = [];
        this.sending = false;
        this.catalogOpen = false;
        this.elements = {};
    }

    async init() {
        const config = await this.fetchConfig();
        if (!config?.enabled) {
            return;
        }

        this.enabled = true;
        this.render();
        this.bindEvents();
    }

    async fetchConfig() {
        try {
            const response = await fetch(`${CHAT_API_BASE}/api/chat/config`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) return { enabled: false };
            return await response.json();
        } catch {

            return { enabled: false };
        }
    }

    render() {
        const root = document.createElement('div');
        root.className = 'chatbot-root';
        root.innerHTML = `
            <button id="chatbot-toggle" class="chatbot-toggle" aria-label="Mở chatbot">
                AI
            </button>
            <section id="chatbot-catalog" class="chatbot-catalog" aria-hidden="true">
                <div class="chatbot-catalog-header">
                    <span>📋 Danh sách câu hỏi có sẵn</span>
                    <button id="chatbot-catalog-close" class="chatbot-catalog-close">✕</button>
                </div>
                <div class="chatbot-catalog-body">
                    ${this.buildCatalogHtml()}
                </div>
            </section>
            <section id="chatbot-panel" class="chatbot-panel" aria-hidden="true">
                <header class="chatbot-header">
                    <strong>Trợ lý AI</strong>
                    <div class="chatbot-header-actions">
                        <button id="chatbot-catalog-btn" class="chatbot-action-btn" aria-label="Danh sách câu hỏi" title="Danh sách câu hỏi">📋</button>
                        <button id="chatbot-new" class="chatbot-action-btn" aria-label="Cuộc trò chuyện mới">Mới</button>
                        <button id="chatbot-clear" class="chatbot-action-btn" aria-label="Xóa cuộc trò chuyện">Xóa</button>
                        <button id="chatbot-close" class="chatbot-close" aria-label="Đóng chatbot">x</button>
                    </div>
                </header>
                <div id="chatbot-messages" class="chatbot-messages">
                    ${this.getWelcomeMessageHtml()}
                </div>
                <form id="chatbot-form" class="chatbot-form">
                    <input id="chatbot-input" type="text" maxlength="1500" placeholder="Nhập câu hỏi..." autocomplete="off" />
                    <button id="chatbot-send" type="submit">Gửi</button>
                </form>
            </section>
        `;

        document.body.appendChild(root);
        this.elements = {
            root,
            toggle: root.querySelector('#chatbot-toggle'),
            panel: root.querySelector('#chatbot-panel'),
            close: root.querySelector('#chatbot-close'),
            newChat: root.querySelector('#chatbot-new'),
            clear: root.querySelector('#chatbot-clear'),
            catalogBtn: root.querySelector('#chatbot-catalog-btn'),
            catalog: root.querySelector('#chatbot-catalog'),
            catalogClose: root.querySelector('#chatbot-catalog-close'),
            form: root.querySelector('#chatbot-form'),
            input: root.querySelector('#chatbot-input'),
            send: root.querySelector('#chatbot-send'),
            messages: root.querySelector('#chatbot-messages')
        };
    }

    buildCatalogHtml() {
        return QUESTION_CATALOG.map(group => `
            <div class="chatbot-catalog-group">
                <div class="chatbot-catalog-category">${group.category}</div>
                ${group.items.map(q => `
                    <button class="chatbot-catalog-item" data-question="${q.replace(/"/g, '&quot;')}">${q}</button>
                `).join('')}
            </div>
        `).join('');
    }

    getWelcomeMessageHtml() {
        return `<div class="chatbot-msg bot">👋 Chào bạn! Mình giúp phân tích task, workload, deadline, năng suất...
<div class="chatbot-welcome-hint">⏰ Lọc theo: <em>hôm qua, tuần này, tháng 1, tháng trước...</em></div>
<div class="chatbot-welcome-hint">💡 Gõ <strong>/help</strong> để xem hướng dẫn, <strong>/catalog</strong> để xem danh sách câu hỏi</div></div>`;
    }

    startNewChat() {
        this.history = [];
        this.elements.messages.innerHTML = this.getWelcomeMessageHtml();
        this.closeCatalog();
        this.elements.input.value = '';
        this.elements.input.focus();
    }

    toggleCatalog() {
        this.catalogOpen = !this.catalogOpen;
        this.elements.catalog.classList.toggle('open', this.catalogOpen);
        this.elements.root.classList.toggle('catalog-open', this.catalogOpen);
        this.elements.catalogBtn.classList.toggle('active', this.catalogOpen);
    }

    closeCatalog() {
        this.catalogOpen = false;
        this.elements.catalog.classList.remove('open');
        this.elements.root.classList.remove('catalog-open');
        this.elements.catalogBtn.classList.remove('active');
    }

    bindEvents() {
        this.elements.toggle.addEventListener('click', () => this.openPanel());
        this.elements.close.addEventListener('click', () => this.closePanel());
        this.elements.newChat.addEventListener('click', () => this.startNewChat());
        this.elements.clear.addEventListener('click', () => this.startNewChat());
        this.elements.catalogBtn.addEventListener('click', () => this.toggleCatalog());
        this.elements.catalogClose.addEventListener('click', () => this.closeCatalog());
        this.elements.form.addEventListener('submit', (event) => {
            event.preventDefault();
            this.sendMessage();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.elements.panel.classList.contains('open')) {
                if (this.catalogOpen) {
                    this.closeCatalog();
                } else {
                    this.closePanel();
                }
            }
        });

        this.bindCatalogEvents();
    }

    bindChipEvents() {
        this.elements.messages.querySelectorAll('.chatbot-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const question = chip.getAttribute('data-question');
                if (question) {
                    this.elements.input.value = question;
                    this.sendMessage();
                }
            });
        });
    }

    bindCatalogEvents() {
        this.elements.catalog.querySelectorAll('.chatbot-catalog-item').forEach(item => {
            item.addEventListener('click', () => {
                const question = item.getAttribute('data-question');
                if (question) {
                    this.elements.input.value = question;
                    this.sendMessage();
                }
            });
        });
    }

    openPanel() {
        this.elements.panel.classList.add('open');
        this.elements.panel.setAttribute('aria-hidden', 'false');
        this.elements.input.focus();
    }

    closePanel() {
        this.elements.panel.classList.remove('open');
        this.elements.panel.setAttribute('aria-hidden', 'true');
        this.closeCatalog();
    }

    appendMessage(role, text) {
        const msg = document.createElement('div');
        msg.className = `chatbot-msg ${role === 'user' ? 'user' : 'bot'}`;
        msg.textContent = text;
        this.elements.messages.appendChild(msg);
        this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
    }

    getFollowUpSuggestions(userMsg) {
        const q = userMsg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        for (const [keyword, suggestions] of Object.entries(FOLLOW_UP_MAP)) {
            if (keyword !== 'default' && q.includes(keyword)) {
                return suggestions;
            }
        }
        return FOLLOW_UP_MAP['default'];
    }

    appendFollowUps(userMsg) {
        const suggestions = this.getFollowUpSuggestions(userMsg);
        if (!suggestions || suggestions.length === 0) return;
        const container = document.createElement('div');
        container.className = 'chatbot-suggestions chatbot-followups';
        suggestions.forEach(s => {
            const btn = document.createElement('button');
            btn.className = 'chatbot-chip chatbot-chip-small';
            btn.textContent = s.text;
            btn.setAttribute('data-question', s.text);
            btn.addEventListener('click', () => {
                this.elements.input.value = s.text;
                this.sendMessage();
            });
            container.appendChild(btn);
        });
        this.elements.messages.appendChild(container);
        this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
    }

    getContext() {
        const reportSelect = document.getElementById('report-type-select');
        const selectedCount = document.getElementById('selected-count');
        const reportTitle = document.getElementById('report-title');
        const selectedDatabaseIds = window.app?.selectedDatabases
            ? Array.from(window.app.selectedDatabases)
            : [];

        return {
            report_type: reportSelect?.value || '',
            selected_count: selectedCount?.textContent?.trim() || '',
            page_title: reportTitle?.textContent?.trim() || 'Dashboard',
            sync_source: window.app?.latestSyncEvent?.type || '',
            selected_database_ids: selectedDatabaseIds
        };
    }

    async sendMessage() {
        const message = this.elements.input.value.trim();
        if (!message || this.sending) {
            return;
        }

        // Handle slash commands
        const cmd = message.toLowerCase().trim();
        if (cmd === '/help') {
            this.elements.input.value = '';
            this.appendMessage('user', message);
            this.appendMessage('bot', '📖 Hướng dẫn sử dụng Trợ lý AI:\n\n• Gõ câu hỏi bằng tiếng Việt tự nhiên\n• Gõ /catalog để xem tất cả câu hỏi có sẵn\n• Gõ /help để xem hướng dẫn này\n• Bấm 📋 ở header để mở danh sách câu hỏi\n\n⏰ Thời gian: hôm qua, tuần này, tháng 1, tháng trước...\n👤 Theo người: "Thịnh có bao nhiêu task?", "Điểm của Vân Trần"\n📊 Tổng quan: "Tổng quan task tuần này", "Ai có nhiều task nhất?"');
            return;
        }
        if (cmd === '/catalog') {
            this.elements.input.value = '';
            this.toggleCatalog();
            return;
        }

        this.sending = true;
        this.elements.send.disabled = true;
        this.elements.input.value = '';

        // Remove any existing follow-up suggestions
        this.elements.messages.querySelectorAll('.chatbot-followups').forEach(el => el.remove());

        this.appendMessage('user', message);
        const pending = document.createElement('div');
        pending.className = 'chatbot-msg bot pending';
        pending.innerHTML = '<span class="chatbot-typing"><span></span><span></span><span></span></span> Đang xử lý...';
        this.elements.messages.appendChild(pending);
        this.elements.messages.scrollTop = this.elements.messages.scrollHeight;

        try {
            const response = await fetch(`${CHAT_API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    context: this.getContext(),
                    history: this.history.slice(-8)
                }),
                signal: AbortSignal.timeout(30000)
            });

            const payload = await response.json();
            pending.remove();

            if (!response.ok || !payload?.success) {
                const errorText = payload?.error || `Yêu cầu lỗi (${response.status})`;
                this.appendMessage('bot', errorText);
                return;
            }

            const reply = String(payload.reply || '').trim() || 'Không có nội dung trả lời.';
            this.appendMessage('bot', reply);

            this.history.push({ role: 'user', content: message });
            this.history.push({ role: 'assistant', content: reply });
            this.history = this.history.slice(-16);

            // Show follow-up suggestions
            this.appendFollowUps(message);
        } catch (error) {
            pending.remove();
            this.appendMessage('bot', `Không gọi được chatbot: ${error.message}`);
        } finally {
            this.sending = false;
            this.elements.send.disabled = false;
            this.elements.input.focus();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const widget = new ChatPreviewWidget();
    widget.init();
});
