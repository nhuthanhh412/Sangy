// Uses window globals from dashboard.js: window.renderRawDataDashboard, window.filterByDateRange

console.log('[raw-table] Loaded, renderRawDataDashboard:', typeof window.renderRawDataDashboard);

// Helper: Find column name from list (case-insensitive, accent-insensitive)
function findColumnName(columns, ...names) {
    const normalizeStr = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    for (const name of names) {
        const normName = normalizeStr(name);
        let found = columns.find(c => c.toLowerCase() === name.toLowerCase());
        if (found) return found;
        found = columns.find(c => normalizeStr(c) === normName);
        if (found) return found;
    }
    for (const name of names) {
        const found = columns.find(c => c.toLowerCase().includes(name.toLowerCase()));
        if (found) return found;
    }
    return undefined;
}

/**
 * Render raw data table with full features
 */
function renderRawDataTable(data, container) {
    if (!data || !data.success) {
        container.innerHTML = `
            <div class="error-message">
                <p>❌ ${data?.error || 'Failed to load data'}</p>
            </div>
        `;
        return;
    }

    const { database_name, columns, data: rows, total_records } = data;
    const storageKey = `rawTable_${database_name.replace(/\s/g, '_')}_hiddenCols`;

    // State
    let filteredRows = [...rows];
    let sortColumn = null;
    let sortDirection = 'asc';
    let currentPage = 1;
    let pageSize = 10;
    let hiddenColumns = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));

    // Filter state
    let dashFilters = {
        startDate: '',
        endDate: '',
        assigneeFilter: '',
        sprintFilter: '',
        activePreset: ''
    };

    // Get visible columns
    const getVisibleColumns = () => columns.filter(col => !hiddenColumns.has(col));

    // Create UI
    const wrapper = document.createElement('div');
    wrapper.className = 'raw-data-view';

    wrapper.innerHTML = `
        <div class="raw-data-header" style="display:flex;justify-content:space-between;align-items:center;">
            <div>
                <h3 style="display:flex;align-items:center;gap:12px;">📊 ${database_name}</h3>
                <p class="data-info">${total_records} records • ${columns.length} columns</p>
            </div>
            <button id="force-refresh-btn" class="btn-small btn-primary-small" style="background:#eab308;color:black;">🔄 Cập nhật từ Notion</button>
        </div>
        
        <!-- Column Visibility Toggle -->
        <div class="column-visibility-section" style="margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <span style="font-size: 0.875rem; color: rgba(255,255,255,0.7);">Columns:</span>
                <div style="display: flex; gap: 0.5rem;">
                    <button id="show-all-cols" class="btn-small">Show All</button>
                    <button id="save-col-config" class="btn-small btn-primary-small">💾 Save Config</button>
                    <button id="reset-col-config" class="btn-small">🔄 Reset</button>
                </div>
            </div>
            <div id="column-toggles" style="display: flex; flex-wrap: wrap; gap: 0.5rem; max-height: 80px; overflow-y: auto; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px;">
                ${columns.map(col => `
                    <label class="column-toggle-label" style="display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; cursor: pointer; font-size: 0.75rem;">
                        <input type="checkbox" data-column="${col}" ${!hiddenColumns.has(col) ? 'checked' : ''}>
                        <span>${col}</span>
                    </label>
                `).join('')}
            </div>
        </div>
        
        <!-- Search & Filter -->
        <div class="raw-data-controls">
            <input type="text" id="raw-search" placeholder="🔍 Search..." 
                style="flex: 1; padding: 0.5rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: white;">
            
            <select id="filter-column" style="padding: 0.5rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: white;">
                <option value="">All Columns</option>
                ${columns.map(col => `<option value="${col}">${col}</option>`).join('')}
            </select>
        </div>
        
        <!-- Pagination Top -->
        <div class="pagination-top" style="display: flex; justify-content: space-between; align-items: center; margin: 1rem 0;">
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <span style="font-size: 0.875rem; color: rgba(255,255,255,0.7);">Show:</span>
                <select id="page-size" style="padding: 0.25rem 0.5rem; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: white;">
                    <option value="10" ${pageSize === 10 ? 'selected' : ''}>10</option>
                    <option value="20" ${pageSize === 20 ? 'selected' : ''}>20</option>
                    <option value="50" ${pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${pageSize === 100 ? 'selected' : ''}>100</option>
                    <option value="200" ${pageSize === 200 ? 'selected' : ''}>200</option>
                    <option value="500" ${pageSize === 500 ? 'selected' : ''}>500</option>
                    <option value="${filteredRows.length}" ${pageSize >= filteredRows.length ? 'selected' : ''}>All</option>
                </select>
                <span style="font-size: 0.875rem; color: rgba(255,255,255,0.7);">rows</span>
            </div>
            <span id="page-info" style="font-size: 0.875rem; color: rgba(255,255,255,0.7);"></span>
        </div>
        
        <!-- Table -->
        <div class="table-container">
            <table id="raw-table">
                <thead>
                    <tr id="raw-thead-row"></tr>
                </thead>
                <tbody id="raw-tbody"></tbody>
            </table>
        </div>
        
        <!-- Pagination Bottom -->
        <div id="pagination-controls" style="display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem;"></div>
        
        <!-- Footer with Export -->
        <div class="raw-data-footer" style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
            <span id="row-count" style="font-size: 0.875rem; color: rgba(255,255,255,0.7);"></span>
            <div style="display: flex; gap: 0.5rem;">
                <button id="export-csv" class="btn-export">📥 Export CSV</button>
                <button id="export-excel" class="btn-export">📊 Export Excel</button>
            </div>
        </div>
    `;

    container.innerHTML = '';
    container.appendChild(wrapper);

    // Render Raw Data Dashboard (charts) - insert after header div
    console.log('[raw-table] Attempting to render dashboard:', {
        hasFn: typeof window.renderRawDataDashboard === 'function',
        rowCount: rows.length,
        dbName: database_name
    });

    if (typeof window.renderRawDataDashboard === 'function' && rows.length > 0) {
        console.log('[raw-table] Calling renderRawDataDashboard with', rows.length, 'rows');
        const headerDiv = wrapper.querySelector('.raw-data-header');
        const dashContainer = document.createElement('div');
        dashContainer.id = 'raw-dashboard-container';
        dashContainer.style.marginTop = '16px';
        if (headerDiv && headerDiv.nextSibling) {
            headerDiv.parentNode.insertBefore(dashContainer, headerDiv.nextSibling);
        } else {
            wrapper.insertBefore(dashContainer, wrapper.children[1] || null);
        }
        try {
            window.renderRawDataDashboard(rows, dashContainer, database_name);
            console.log('[raw-table] Dashboard rendered successfully');
        } catch (err) {
            console.error('[raw-table] Dashboard error:', err);
        }
    } else {
        console.log('[raw-table] Skipping dashboard - condition not met');
    }

    // Render table headers
    const renderHeaders = () => {
        const theadRow = document.getElementById('raw-thead-row');
        const visibleCols = getVisibleColumns();
        theadRow.innerHTML = visibleCols.map(col => `
            <th data-column="${col}" style="cursor: pointer; user-select: none;">
                ${col} <span class="sort-indicator">${sortColumn === col ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
            </th>
        `).join('');

        // Re-attach sort listeners
        theadRow.querySelectorAll('th').forEach(th => {
            th.addEventListener('click', () => handleSort(th.dataset.column));
        });
    };

    // Render table body with pagination
    const renderTable = () => {
        const visibleCols = getVisibleColumns();
        const start = (currentPage - 1) * pageSize;
        const end = start + pageSize;
        const pageData = filteredRows.slice(start, end);
        const totalPages = Math.ceil(filteredRows.length / pageSize);

        const tbody = document.getElementById('raw-tbody');
        tbody.innerHTML = pageData.map(row => `
            <tr>
                ${visibleCols.map(col => `<td>${escapeHtml(row[col] || '')}</td>`).join('')}
            </tr>
        `).join('');

        // Update info
        document.getElementById('page-info').textContent =
            `Showing ${start + 1}-${Math.min(end, filteredRows.length)} / ${filteredRows.length} rows`;
        document.getElementById('row-count').textContent =
            `Filtered: ${filteredRows.length} / ${total_records} total • Showing ${visibleCols.length} columns`;

        // Render pagination controls
        renderPagination(totalPages);
    };

    // Render pagination buttons
    const renderPagination = (totalPages) => {
        const container = document.getElementById('pagination-controls');
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = '';

        // Previous button
        html += `<button class="pagination-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">← Prev</button>`;

        // Page numbers
        const maxVisible = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);

        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        if (startPage > 1) {
            html += `<button class="pagination-btn" data-page="1">1</button>`;
            if (startPage > 2) html += `<span style="color: rgba(255,255,255,0.5);">...</span>`;
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<span style="color: rgba(255,255,255,0.5);">...</span>`;
            html += `<button class="pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
        }

        // Next button
        html += `<button class="pagination-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next →</button>`;

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.pagination-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page >= 1 && page <= totalPages) {
                    currentPage = page;
                    renderTable();
                }
            });
        });
    };

    // Handle sort
    const handleSort = (column) => {
        if (sortColumn === column) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            sortColumn = column;
            sortDirection = 'asc';
        }

        filteredRows.sort((a, b) => {
            let aVal = a[column] || '';
            let bVal = b[column] || '';

            const aNum = parseFloat(aVal);
            const bNum = parseFloat(bVal);

            if (!isNaN(aNum) && !isNaN(bNum)) {
                return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
            }

            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();

            if (sortDirection === 'asc') {
                return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            } else {
                return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
            }
        });

        renderHeaders();
        renderTable();
    };

    // Centralized filter application
    const applyAllFilters = () => {
        const query = document.getElementById('raw-search')?.value.toLowerCase() || '';
        const filterCol = document.getElementById('filter-column')?.value;

        // 1. Start with all rows
        let result = rows;

        // 2. Apply dashboard filters
        const { startDate, endDate, assigneeFilter, sprintFilter } = dashFilters;

        const findCol = (...names) => findColumnName(columns, ...names);
        const assigneeCol = findCol('ASSIGNEE', 'Người thực hiện', 'Assignee', 'Người làm', 'OWNER', 'Owner');
        const sprintCol = findCol('Sprint', 'SPRINT');
        const dateCol = findCol('DoneDate', 'Done Date', 'DONE DATE');
        const fallbackDateCol = findCol('LastEditTime', 'Last Edit Time', 'LastEdited', 'NGÀY LÀM', 'Ngày làm', 'Updated');

        if (assigneeFilter && assigneeCol) {
            result = result.filter(r => r[assigneeCol] === assigneeFilter);
        }
        if (sprintFilter && sprintCol) {
            result = result.filter(r => r[sprintCol] === sprintFilter);
        }
        if (dateCol && (startDate || endDate)) {
            result = window.filterByDateRange(result, dateCol, fallbackDateCol, startDate, endDate);
        }

        // 3. Apply search query
        if (query) {
            result = result.filter(row => {
                if (filterCol) {
                    const value = String(row[filterCol] || '').toLowerCase();
                    return value.includes(query);
                } else {
                    return columns.some(col => {
                        const value = String(row[col] || '').toLowerCase();
                        return value.includes(query);
                    });
                }
            });
        }

        filteredRows = result;
        currentPage = 1;
        renderTable();

        // 4. Re-render dashboard charts with filtered data (Issue 2: sync dash & table)
        const dashContainer = document.getElementById('raw-dashboard-container');
        if (dashContainer && typeof window.renderRawDataDashboard === 'function') {
            try {
                window.renderRawDataDashboard(filteredRows, dashContainer, database_name, {
                    startDate,
                    endDate,
                    assigneeFilter,
                    sprintFilter,
                    activePreset: dashFilters.activePreset || 'all',
                    onFilterChange: (newFilters) => {
                        dashFilters = { ...dashFilters, ...newFilters };
                        applyAllFilters();
                    }
                });
                console.log('[raw-table] Dashboard re-rendered with', filteredRows.length, 'filtered rows');
            } catch (err) {
                console.error('[raw-table] Dashboard re-render error:', err);
            }
        }
    };

    // Handle search input
    const handleSearch = () => {
        applyAllFilters();
    };

    // Clean up previous listener to prevent leaks/duplicates
    if (document.rawTableFilterHandler) {
        document.removeEventListener('dashboard-filter-change', document.rawTableFilterHandler);
    }

    // Create new handler
    document.rawTableFilterHandler = (e) => {
        console.log('[raw-table] Filter changed:', e.detail);
        dashFilters = { ...dashFilters, ...e.detail };
        applyAllFilters();
    };

    // Attach listener
    document.addEventListener('dashboard-filter-change', document.rawTableFilterHandler);

    // Event listeners
    document.getElementById('force-refresh-btn')?.addEventListener('click', () => {
        const btn = document.getElementById('force-refresh-btn');
        btn.disabled = true;
        btn.textContent = '⏳ Đang tải...';

        // Dispatch event to app.js to handle refresh
        const event = new CustomEvent('request-raw-refresh', {
            detail: { databaseId: data.database_id }
        });
        document.dispatchEvent(event);
    });

    document.getElementById('raw-search').addEventListener('input', handleSearch);
    document.getElementById('filter-column').addEventListener('change', handleSearch);

    document.getElementById('page-size').addEventListener('change', (e) => {
        pageSize = parseInt(e.target.value);
        currentPage = 1;
        renderTable();
    });

    // Column visibility toggles
    document.getElementById('column-toggles').addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
            const col = e.target.dataset.column;
            if (e.target.checked) {
                hiddenColumns.delete(col);
            } else {
                hiddenColumns.add(col);
            }
            renderHeaders();
            renderTable();
        }
    });

    document.getElementById('show-all-cols').addEventListener('click', () => {
        hiddenColumns.clear();
        document.querySelectorAll('#column-toggles input').forEach(cb => cb.checked = true);
        renderHeaders();
        renderTable();
    });

    document.getElementById('save-col-config').addEventListener('click', () => {
        localStorage.setItem(storageKey, JSON.stringify([...hiddenColumns]));
        Modal.showAlert('✅ Column configuration saved!', 'success');
    });

    document.getElementById('reset-col-config').addEventListener('click', () => {
        localStorage.removeItem(storageKey);
        hiddenColumns.clear();
        document.querySelectorAll('#column-toggles input').forEach(cb => cb.checked = true);
        renderHeaders();
        renderTable();
        Modal.showAlert('✅ Configuration reset!', 'success');
    });

    // Export CSV
    document.getElementById('export-csv').addEventListener('click', () => {
        const visibleCols = getVisibleColumns();
        const csv = [
            visibleCols.join(','),
            ...filteredRows.map(row =>
                visibleCols.map(col => {
                    const val = row[col] || '';
                    return `"${String(val).replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '')}"`;
                }).join(',')
            )
        ].join('\n');

        // Add date to filename
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        downloadFile(csv, `${database_name.replace(/[^a-z0-9]/gi, '_')}_${dateStr}.csv`, 'text/csv');
    });

    // Export Excel (simple HTML table based)
    document.getElementById('export-excel').addEventListener('click', () => {
        const visibleCols = getVisibleColumns();
        const html = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
            <head><meta charset="UTF-8"></head>
            <body>
                <table border="1">
                    <tr>${visibleCols.map(col => `<th style="background:#4a5568;color:white;font-weight:bold;">${col}</th>`).join('')}</tr>
                    ${filteredRows.map(row => `
                        <tr>${visibleCols.map(col => `<td>${escapeHtml(row[col] || '')}</td>`).join('')}</tr>
                    `).join('')}
                </table>
            </body>
            </html>
        `;
        // Add date to filename
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        downloadFile(html, `${database_name.replace(/[^a-z0-9]/gi, '_')}_${dateStr}.xls`, 'application/vnd.ms-excel');
    });

    // Initial render
    renderHeaders();
    renderTable();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function downloadFile(content, filename, mimeType) {
    // Add UTF-8 BOM for CSV files to ensure Excel reads encoding correctly
    if (mimeType.includes('csv')) {
        content = '\uFEFF' + content;
    }

    const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

window.renderRawDataTable = renderRawDataTable;
