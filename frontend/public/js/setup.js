// setup.js - Database setup wizard
const API_BASE = window.location.origin;

class SetupWizard {
    constructor() {
        this.selectedDatabases = new Set();
    }

    async init() {
        console.log('[Setup] Initializing setup wizard...');
        await this.loadDatabases();
        this.setupEventListeners();
    }

    async loadDatabases() {
        const databaseList = document.getElementById('database-list');

        if (!databaseList) {
            console.error('[Setup] database-list element not found');
            return;
        }

        // Add Search Input
        if (!document.getElementById('db-search-input')) {
            const searchContainer = document.createElement('div');
            searchContainer.style.marginBottom = '1rem';

            const searchInput = document.createElement('input');
            searchInput.id = 'db-search-input';
            searchInput.type = 'text';
            searchInput.placeholder = '🔍 Tìm kiếm database...';
            searchInput.style.width = '100%';
            searchInput.style.padding = '0.75rem';
            searchInput.style.background = 'rgba(255, 255, 255, 0.05)';
            searchInput.style.border = '1px solid rgba(255, 255, 255, 0.1)';
            searchInput.style.borderRadius = '8px';
            searchInput.style.color = 'white';
            searchInput.style.outline = 'none';
            searchInput.style.marginBottom = '0.5rem';

            searchInput.addEventListener('input', (e) => this.filterDatabases(e.target.value));

            searchContainer.appendChild(searchInput);
            databaseList.parentNode.insertBefore(searchContainer, databaseList);
        }

        databaseList.innerHTML = '<p>Loading databases...</p>';

        try {
            console.log('[Setup] Fetching databases from API...');
            const response = await fetch(`${API_BASE}/api/databases`, {
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log('[Setup] Received databases:', data);

            if (!data.success || !data.databases || data.databases.length === 0) {
                databaseList.innerHTML = `
          <div style="text-align: center; padding: 2rem; color: #f87171;">
            <p>⚠️ Không tìm thấy databases</p>
            <p style="font-size: 0.9rem; margin-top: 0.5rem;">
              Hãy đảm bảo bạn đã share databases với Notion Integration
            </p>
          </div>
        `;
                return;
            }

            databaseList.innerHTML = '';
            data.databases.forEach(db => {
                const item = this.createDatabaseItem(db);
                databaseList.appendChild(item);
            });

            console.log(`[Setup] Loaded ${data.databases.length} databases`);
        } catch (error) {
            console.error('[Setup] Error loading databases:', error);
            databaseList.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: #f87171;">
          <p>❌ Lỗi khi load databases</p>
          <p style="font-size: 0.9rem; margin-top: 0.5rem;">${error.message}</p>
        </div>
      `;
        }
    }

    filterDatabases(query) {
        const items = document.querySelectorAll('.database-item');
        const searchTerm = query.toLowerCase();

        items.forEach(item => {
            const title = item.querySelector('div[style*="font-weight: 600"]').textContent.toLowerCase();
            if (title.includes(searchTerm)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    createDatabaseItem(database) {
        const div = document.createElement('div');
        div.className = 'database-item';
        div.dataset.id = database.id;
        div.style.cssText = `
      display: flex;
      align-items: center;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
    `;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `db-${database.id}`;
        checkbox.value = database.id;
        checkbox.style.cssText = 'margin-right: 1rem; cursor: pointer;';

        const label = document.createElement('label');
        label.htmlFor = `db-${database.id}`;
        label.style.cssText = 'cursor: pointer; flex: 1;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; margin-bottom: 0.25rem;';
        title.textContent = database.name || 'Untitled Database';

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size: 0.875rem; color: rgba(255, 255, 255, 0.6);';
        meta.textContent = `${database.properties?.length || 0} properties`;

        label.appendChild(title);
        label.appendChild(meta);

        div.appendChild(checkbox);
        div.appendChild(label);

        // Toggle selection
        div.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }

            if (checkbox.checked) {
                div.style.background = 'rgba(99, 102, 241, 0.2)';
                div.style.borderColor = 'rgba(99, 102, 241, 0.5)';
                this.selectedDatabases.add(database.id);
            } else {
                div.style.background = 'rgba(255, 255, 255, 0.05)';
                div.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                this.selectedDatabases.delete(database.id);
            }

            console.log('[Setup] Selected databases:', Array.from(this.selectedDatabases));
        });

        // Hover effect
        div.addEventListener('mouseenter', () => {
            if (!checkbox.checked) {
                div.style.background = 'rgba(255, 255, 255, 0.08)';
            }
        });

        div.addEventListener('mouseleave', () => {
            if (!checkbox.checked) {
                div.style.background = 'rgba(255, 255, 255, 0.05)';
            }
        });

        return div;
    }

    setupEventListeners() {
        const saveBtn = document.getElementById('save-databases-btn');
        const selectAllBtn = document.getElementById('select-all-btn');
        const deselectAllBtn = document.getElementById('deselect-all-btn');

        if (!saveBtn) {
            console.error('[Setup] save-databases-btn not found');
            return;
        }

        saveBtn.addEventListener('click', () => this.saveDatabases());

        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => this.selectAll());
        }

        if (deselectAllBtn) {
            deselectAllBtn.addEventListener('click', () => this.deselectAll());
        }

        console.log('[Setup] Event listeners attached');
    }

    selectAll() {
        const checkboxes = document.querySelectorAll('#database-list input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (!checkbox.checked) {
                checkbox.checked = true;
                const item = checkbox.closest('.database-item');
                if (item) {
                    item.style.background = 'rgba(99, 102, 241, 0.2)';
                    item.style.borderColor = 'rgba(99, 102, 241, 0.5)';
                }
                this.selectedDatabases.add(checkbox.value);
            }
        });
        console.log('[Setup] Selected all databases:', Array.from(this.selectedDatabases));
    }

    deselectAll() {
        const checkboxes = document.querySelectorAll('#database-list input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            if (checkbox.checked) {
                checkbox.checked = false;
                const item = checkbox.closest('.database-item');
                if (item) {
                    item.style.background = 'rgba(255, 255, 255, 0.05)';
                    item.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                }
                this.selectedDatabases.delete(checkbox.value);
            }
        });
        console.log('[Setup] Deselected all databases');
    }

    async saveDatabases() {
        console.log('[Setup] Saving databases...', Array.from(this.selectedDatabases));

        if (this.selectedDatabases.size === 0) {
            Modal.showAlert('Vui lòng chọn ít nhất một database', 'warning');
            return;
        }

        const saveBtn = document.getElementById('save-databases-btn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Đang lưu...';

        try {
            const response = await fetch(`${API_BASE}/api/databases/select`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({
                    database_ids: Array.from(this.selectedDatabases)
                })
            });

            const data = await response.json();
            console.log('[Setup] Save response:', data);

            if (data.success) {
                console.log('[Setup] ✅ Databases saved successfully');
                // Redirect to dashboard with setup complete flag
                window.location.href = '/?setup=complete';
            } else {
                Modal.showAlert('Lỗi khi lưu databases: ' + data.error, 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save & Continue';
            }
        } catch (error) {
            console.error('[Setup] Error saving databases:', error);
            Modal.showAlert('Lỗi khi lưu databases. Vui lòng thử lại.', 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save & Continue';
        }
    }
}

// Export for use by auth.js
window.SetupWizard = SetupWizard;
