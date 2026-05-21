// ==UserScript==
// @name         Kudu Umbraco Log Viewer
// @namespace    https://github.com/skttl/umbraco-userscripts
// @version      1.1.0
// @description  View Umbraco Serilog JSON log files inside Kudu for Umbraco Cloud
// @author       skttl
// @homepage     https://github.com/skttl/umbraco-userscripts
// @supportURL   https://github.com/skttl/umbraco-userscripts/issues
// @license      MIT
// @include      /^https?:\/\/.*\.scm\..*\.umbraco\.io\/.*$/
// @grant        none
// @run-at       document-end
// @compatible   chrome Tampermonkey
// @compatible   firefox Tampermonkey
// @compatible   edge Tampermonkey
// ==/UserScript==

(function() {
    'use strict';

    const LOGS_BASE_PATH = '/api/vfs/site/wwwroot/umbraco/Logs/';
    const PAGE_SIZE = 100;
    const VIEWER_NAME = 'umbracolog';

    let isViewerActive = false;
    let allEntries = [];
    let filteredEntries = [];
    let currentPage = 1;
    let sortDescending = true;
    let activeLevels = new Set(['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal']);
    let searchText = '';

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderMessageTemplate(template, properties) {
        if (!template) return '';
        return template.replace(/\{([^}]+)\}/g, (match, key) => {
            const clean = key.replace(/:.*$/, '');
            if (properties && properties[clean] !== undefined) {
                const val = properties[clean];
                return typeof val === 'object' ? JSON.stringify(val) : String(val);
            }
            return match;
        });
    }

    function parseLogEntry(line) {
        try {
            const obj = JSON.parse(line);
            const timestamp = obj['@t'] || '';
            const level = obj['@l'] || 'Information';
            const messageTemplate = obj['@mt'] || '';
            const renderedMessage = obj['@m'] || renderMessageTemplate(messageTemplate, obj);
            const exception = obj['@x'] || '';

            const reserved = new Set(['@t', '@mt', '@m', '@l', '@x', '@i', '@r']);
            const properties = {};
            for (const key of Object.keys(obj)) {
                if (!reserved.has(key)) {
                    properties[key] = obj[key];
                }
            }

            return { timestamp, level, messageTemplate, renderedMessage, exception, properties };
        } catch (e) {
            return null;
        }
    }

    function levelToLabelClass(level) {
        switch (level) {
            case 'Fatal': return 'label-danger';
            case 'Error': return 'label-danger';
            case 'Warning': return 'label-warning';
            case 'Information': return 'label-info';
            case 'Debug': return 'label-default';
            case 'Verbose': return 'label-default';
            default: return 'label-default';
        }
    }

    // --- Navbar integration (same pattern as other viewers) ---

    function addNavbarLink() {
        const navbar = document.querySelector('body > .navbar:first-child');
        if (!navbar) return;

        const navList = navbar.querySelector('.nav.navbar-nav');
        if (!navList || document.getElementById('umbracolog-nav-link')) return;

        const li = document.createElement('li');
        li.id = 'umbracolog-nav-link';

        const link = document.createElement('a');
        link.href = '#';
        link.textContent = 'Umbraco Logs';
        link.onclick = (e) => {
            e.preventDefault();
            toggleViewer();
        };

        li.appendChild(link);
        navList.appendChild(li);
    }

    function toggleViewer(skipHistory = false) {
        if (isViewerActive) {
            hideViewer(skipHistory);
        } else {
            showViewer(skipHistory);
        }
    }

    function showViewer(skipHistory = false) {
        const navbar = document.querySelector('body > .navbar:first-child');
        if (!navbar) return;

        const navList = navbar.querySelector('.nav.navbar-nav');
        if (navList) {
            navList.querySelectorAll('li').forEach(li => li.classList.remove('active'));
        }

        window.dispatchEvent(new CustomEvent('viewer-change', { detail: { viewer: VIEWER_NAME } }));

        let nextSibling = navbar.nextElementSibling;
        while (nextSibling) {
            if (nextSibling.id !== 'umbracolog-viewer-panel') {
                nextSibling.style.display = 'none';
            }
            nextSibling = nextSibling.nextElementSibling;
        }

        if (!document.getElementById('umbracolog-viewer-panel')) {
            createViewerPanel();
            loadFileList();
        } else {
            document.getElementById('umbracolog-viewer-panel').style.display = 'block';
        }

        isViewerActive = true;

        if (!skipHistory) {
            history.pushState({ view: VIEWER_NAME }, 'Umbraco Logs', window.location.pathname + '?' + VIEWER_NAME);
        }

        updateNavbarState();
    }

    function hideViewer(skipHistory = false) {
        const navbar = document.querySelector('body > .navbar:first-child');
        if (!navbar) return;

        let nextSibling = navbar.nextElementSibling;
        while (nextSibling) {
            if (nextSibling.id !== 'umbracolog-viewer-panel') {
                nextSibling.style.display = '';
            }
            nextSibling = nextSibling.nextElementSibling;
        }

        const panel = document.getElementById('umbracolog-viewer-panel');
        if (panel) {
            panel.style.display = 'none';
        }

        isViewerActive = false;

        if (!skipHistory) {
            history.pushState({ view: null }, '', window.location.pathname);
        }

        updateNavbarState();
    }

    function updateNavbarState() {
        const currentState = history.state;
        const navLink = document.getElementById('umbracolog-nav-link');

        if (navLink) {
            if (currentState && currentState.view === VIEWER_NAME) {
                navLink.classList.add('active');
            } else {
                navLink.classList.remove('active');
            }
        }
    }

    // --- Panel creation ---

    function createViewerPanel() {
        const panel = document.createElement('div');
        panel.id = 'umbracolog-viewer-panel';
        panel.className = 'container';
        panel.style.marginTop = '20px';

        const header = document.createElement('div');
        header.className = 'page-header';
        header.innerHTML = '<h1>Umbraco Log Viewer</h1>';
        panel.appendChild(header);

        // File picker row
        const fileRow = document.createElement('div');
        fileRow.className = 'form-inline';
        fileRow.style.marginBottom = '15px';

        const fileLabel = document.createElement('label');
        fileLabel.textContent = 'Log file: ';
        fileLabel.style.marginRight = '8px';
        fileRow.appendChild(fileLabel);

        const fileSelect = document.createElement('select');
        fileSelect.id = 'umbracolog-file-select';
        fileSelect.className = 'form-control';
        fileSelect.style.marginRight = '10px';
        fileSelect.onchange = () => loadSelectedFile();
        fileRow.appendChild(fileSelect);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn btn-default';
        refreshBtn.textContent = 'Reload';
        refreshBtn.onclick = () => loadSelectedFile();
        fileRow.appendChild(refreshBtn);

        panel.appendChild(fileRow);

        // Filter toolbar
        const toolbar = document.createElement('div');
        toolbar.id = 'umbracolog-toolbar';
        toolbar.className = 'well well-sm';
        toolbar.style.display = 'none';

        // Search input row
        const searchRow = document.createElement('div');
        searchRow.className = 'form-inline';
        searchRow.style.marginBottom = '8px';

        const searchInput = document.createElement('input');
        searchInput.id = 'umbracolog-search';
        searchInput.type = 'text';
        searchInput.className = 'form-control';
        searchInput.placeholder = 'Search log messages...';
        searchInput.style.width = '300px';
        searchInput.style.marginRight = '10px';
        searchInput.oninput = () => {
            searchText = searchInput.value;
            applyFilters();
        };
        searchRow.appendChild(searchInput);

        const sortBtn = document.createElement('button');
        sortBtn.id = 'umbracolog-sort-btn';
        sortBtn.className = 'btn btn-default btn-sm';
        sortBtn.textContent = '↓ Newest first';
        sortBtn.onclick = () => {
            sortDescending = !sortDescending;
            sortBtn.textContent = sortDescending ? '↓ Newest first' : '↑ Oldest first';
            applyFilters();
        };
        searchRow.appendChild(sortBtn);

        toolbar.appendChild(searchRow);

        // Level filter — dropdown with checkboxes
        const levelDropdownWrap = document.createElement('div');
        levelDropdownWrap.className = 'btn-group';
        levelDropdownWrap.style.position = 'relative';

        const levelToggleBtn = document.createElement('button');
        levelToggleBtn.id = 'umbracolog-level-toggle';
        levelToggleBtn.className = 'btn btn-default btn-sm dropdown-toggle';
        levelToggleBtn.type = 'button';
        levelToggleBtn.innerHTML = 'Levels <span class="caret"></span>';
        levelDropdownWrap.appendChild(levelToggleBtn);

        const levelPanel = document.createElement('div');
        levelPanel.id = 'umbracolog-level-panel';
        levelPanel.style.cssText = 'display:none;position:absolute;top:100%;left:0;z-index:1000;background:#fff;border:1px solid #ccc;border-radius:4px;padding:8px 12px;min-width:160px;box-shadow:0 3px 8px rgba(0,0,0,.15);';

        // Select all / none row
        const allNoneRow = document.createElement('div');
        allNoneRow.style.cssText = 'margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #eee;display:flex;gap:6px;';

        const selectAllBtn = document.createElement('a');
        selectAllBtn.href = '#';
        selectAllBtn.textContent = 'All';
        selectAllBtn.style.fontSize = '12px';
        selectAllBtn.onclick = (e) => {
            e.preventDefault();
            levelPanel.querySelectorAll('input[type=checkbox]').forEach(cb => {
                cb.checked = true;
                activeLevels.add(cb.value);
            });
            updateLevelToggleLabel();
            applyFilters();
        };

        const selectNoneBtn = document.createElement('a');
        selectNoneBtn.href = '#';
        selectNoneBtn.textContent = 'None';
        selectNoneBtn.style.fontSize = '12px';
        selectNoneBtn.onclick = (e) => {
            e.preventDefault();
            levelPanel.querySelectorAll('input[type=checkbox]').forEach(cb => {
                cb.checked = false;
                activeLevels.delete(cb.value);
            });
            updateLevelToggleLabel();
            applyFilters();
        };

        allNoneRow.appendChild(selectAllBtn);
        allNoneRow.appendChild(document.createTextNode('·'));
        allNoneRow.appendChild(selectNoneBtn);
        levelPanel.appendChild(allNoneRow);

        const levels = ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal'];
        levels.forEach(level => {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:4px;font-weight:normal;';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.value = level;
            cb.onchange = () => {
                if (cb.checked) {
                    activeLevels.add(level);
                } else {
                    activeLevels.delete(level);
                }
                updateLevelToggleLabel();
                applyFilters();
            };

            const badge = document.createElement('span');
            badge.className = 'label ' + levelToLabelClass(level);
            badge.textContent = level;

            lbl.appendChild(cb);
            lbl.appendChild(badge);
            levelPanel.appendChild(lbl);
        });

        levelDropdownWrap.appendChild(levelPanel);
        toolbar.appendChild(levelDropdownWrap);

        levelToggleBtn.onclick = (e) => {
            e.stopPropagation();
            const open = levelPanel.style.display !== 'none';
            levelPanel.style.display = open ? 'none' : 'block';
        };

        document.addEventListener('click', () => {
            levelPanel.style.display = 'none';
        }, true);

        levelPanel.addEventListener('click', (e) => e.stopPropagation());

        panel.appendChild(toolbar);

        // Momentum graph
        const graphContainer = document.createElement('div');
        graphContainer.id = 'umbracolog-graph-container';
        graphContainer.style.cssText = 'display:none;margin-bottom:16px;';

        const graphCanvas = document.createElement('canvas');
        graphCanvas.id = 'umbracolog-graph';
        graphCanvas.height = 80;
        graphCanvas.style.cssText = 'width:100%;height:80px;display:block;cursor:crosshair;';
        graphContainer.appendChild(graphCanvas);

        const graphLegend = document.createElement('div');
        graphLegend.id = 'umbracolog-graph-legend';
        graphLegend.style.cssText = 'font-size:11px;color:#999;text-align:right;margin-top:2px;';
        graphContainer.appendChild(graphLegend);

        panel.appendChild(graphContainer);

        // Status bar
        const statusBar = document.createElement('div');
        statusBar.id = 'umbracolog-status';
        statusBar.style.marginBottom = '10px';
        statusBar.style.color = '#777';
        panel.appendChild(statusBar);

        // Log content area
        const content = document.createElement('div');
        content.id = 'umbracolog-content';
        panel.appendChild(content);

        // Pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.id = 'umbracolog-pagination';
        paginationContainer.style.textAlign = 'center';
        panel.appendChild(paginationContainer);

        document.body.appendChild(panel);
    }

    // --- File listing & loading ---

    async function loadFileList() {
        const select = document.getElementById('umbracolog-file-select');
        select.innerHTML = '<option>Loading...</option>';

        try {
            const res = await fetch(LOGS_BASE_PATH);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const items = await res.json();

            const jsonFiles = items
                .filter(item => item.name && item.name.endsWith('.json'))
                .map(item => item.name)
                .sort()
                .reverse();

            select.innerHTML = '';

            if (jsonFiles.length === 0) {
                select.innerHTML = '<option>No log files found</option>';
                return;
            }

            jsonFiles.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            });

            loadSelectedFile();
        } catch (err) {
            select.innerHTML = '<option>Error loading file list</option>';
            const content = document.getElementById('umbracolog-content');
            content.innerHTML = `<div class="alert alert-danger">Failed to load log file list: ${escapeHtml(err.message)}</div>`;
        }
    }

    async function loadSelectedFile() {
        const select = document.getElementById('umbracolog-file-select');
        const filename = select.value;
        if (!filename) return;

        const content = document.getElementById('umbracolog-content');
        const toolbar = document.getElementById('umbracolog-toolbar');
        const statusBar = document.getElementById('umbracolog-status');
        const pagination = document.getElementById('umbracolog-pagination');

        content.innerHTML = '<div class="alert alert-info">Loading log file...</div>';
        toolbar.style.display = 'none';
        statusBar.textContent = '';
        pagination.innerHTML = '';

        try {
            const res = await fetch(LOGS_BASE_PATH + encodeURIComponent(filename));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();

            const lines = text.split('\n').filter(l => l.trim());
            allEntries = [];
            let skipped = 0;

            for (const line of lines) {
                const entry = parseLogEntry(line);
                if (entry) {
                    allEntries.push(entry);
                } else {
                    skipped++;
                }
            }

            toolbar.style.display = 'block';
            currentPage = 1;
            applyFilters();

            if (skipped > 0) {
                console.warn(`Umbraco Log Viewer: Skipped ${skipped} malformed lines in ${filename}`);
            }
        } catch (err) {
            content.innerHTML = `<div class="alert alert-danger">Failed to load log file: ${escapeHtml(err.message)}</div>`;
        }
    }

    // --- Filtering, sorting, pagination ---

    function updateLevelToggleLabel() {
        const btn = document.getElementById('umbracolog-level-toggle');
        if (!btn) return;
        const total = 6;
        const active = activeLevels.size;
        const label = active === total ? 'All levels' :
                       active === 0    ? 'No levels' :
                       active === 1    ? [...activeLevels][0] :
                       `${active} levels`;
        btn.innerHTML = label + ' <span class="caret"></span>';
    }

    function applyFilters() {
        const lowerSearch = searchText.toLowerCase();

        filteredEntries = allEntries.filter(entry => {
            if (!activeLevels.has(entry.level)) return false;
            if (lowerSearch && !entry.renderedMessage.toLowerCase().includes(lowerSearch)) return false;
            return true;
        });

        filteredEntries.sort((a, b) => {
            const ta = new Date(a.timestamp).getTime();
            const tb = new Date(b.timestamp).getTime();
            return sortDescending ? tb - ta : ta - tb;
        });

        currentPage = 1;
        renderMomentumGraph();
        renderCurrentPage();
    }

    function renderMomentumGraph() {
        const container = document.getElementById('umbracolog-graph-container');
        const canvas = document.getElementById('umbracolog-graph');
        const legend = document.getElementById('umbracolog-graph-legend');
        if (!container || !canvas || !legend) return;

        if (allEntries.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';

        const timestamps = allEntries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
        if (timestamps.length === 0) { container.style.display = 'none'; return; }

        const minT = Math.min(...timestamps);
        const maxT = Math.max(...timestamps);
        const span = maxT - minT || 1;

        const NUM_BUCKETS = 60;
        const bucketSize = span / NUM_BUCKETS;

        const levelColors = {
            Fatal:       '#d9534f',
            Error:       '#e8735a',
            Warning:     '#f0ad4e',
            Information: '#5bc0de',
            Debug:       '#aaa',
            Verbose:     '#ccc'
        };
        const levelStack = ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal'];

        // counts[bucket][level]
        const counts = Array.from({ length: NUM_BUCKETS }, () => ({}));
        for (const entry of allEntries) {
            const t = new Date(entry.timestamp).getTime();
            if (isNaN(t)) continue;
            const idx = Math.min(NUM_BUCKETS - 1, Math.floor((t - minT) / bucketSize));
            counts[idx][entry.level] = (counts[idx][entry.level] || 0) + 1;
        }

        const totals = counts.map(b => levelStack.reduce((s, l) => s + (b[l] || 0), 0));
        const maxCount = Math.max(...totals, 1);

        // Scale canvas to physical pixels
        const dpr = window.devicePixelRatio || 1;
        const displayW = canvas.parentElement.clientWidth || 800;
        canvas.width  = displayW * dpr;
        canvas.height = 80 * dpr;
        canvas.style.width  = displayW + 'px';
        canvas.style.height = '80px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const W = displayW;
        const H = 80;
        const barW = W / NUM_BUCKETS;

        ctx.clearRect(0, 0, W, H);

        // Draw faint horizontal gridlines
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = 1;
        for (let g = 0; g <= 4; g++) {
            const y = H - (g / 4) * H;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        // Draw stacked bars
        for (let i = 0; i < NUM_BUCKETS; i++) {
            let yBase = H;
            for (const level of levelStack) {
                const cnt = counts[i][level] || 0;
                if (!cnt) continue;
                const barH = (cnt / maxCount) * H;
                yBase -= barH;
                ctx.fillStyle = levelColors[level] || '#999';
                ctx.fillRect(i * barW + 0.5, yBase, Math.max(1, barW - 1), barH);
            }
        }

        // Highlight filtered entries in a thin overlay line
        if (filteredEntries.length !== allEntries.length) {
            const fCounts = new Array(NUM_BUCKETS).fill(0);
            for (const entry of filteredEntries) {
                const t = new Date(entry.timestamp).getTime();
                if (isNaN(t)) continue;
                const idx = Math.min(NUM_BUCKETS - 1, Math.floor((t - minT) / bucketSize));
                fCounts[idx]++;
            }
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 2]);
            ctx.beginPath();
            for (let i = 0; i < NUM_BUCKETS; i++) {
                const x = i * barW + barW / 2;
                const y = H - (fCounts[i] / maxCount) * H;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Legend
        const bucketMinutes = Math.round(bucketSize / 60000);
        const bucketLabel = bucketMinutes >= 60
            ? `${Math.round(bucketMinutes / 60)}h`
            : bucketMinutes >= 1 ? `${bucketMinutes}m` : `${Math.round(bucketSize / 1000)}s`;
        const fromStr = new Date(minT).toLocaleString();
        const toStr   = new Date(maxT).toLocaleString();
        legend.textContent = `${fromStr} → ${toStr}  ·  ${NUM_BUCKETS} buckets × ${bucketLabel}  ·  peak ${maxCount} msgs`;
    }

    function renderCurrentPage() {
        const content = document.getElementById('umbracolog-content');
        const statusBar = document.getElementById('umbracolog-status');
        const pagination = document.getElementById('umbracolog-pagination');

        const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;

        const start = (currentPage - 1) * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, filteredEntries.length);
        const pageEntries = filteredEntries.slice(start, end);

        statusBar.textContent = `Showing ${filteredEntries.length === 0 ? 0 : start + 1}–${end} of ${filteredEntries.length} entries` +
            (filteredEntries.length !== allEntries.length ? ` (${allEntries.length} total)` : '');

        content.innerHTML = '';

        if (pageEntries.length === 0) {
            content.innerHTML = '<div class="alert alert-warning">No log entries match the current filters.</div>';
            pagination.innerHTML = '';
            return;
        }

        // Table header
        const table = document.createElement('table');
        table.className = 'table table-hover';
        table.style.tableLayout = 'fixed';
        table.style.wordWrap = 'break-word';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th style="width: 170px;">Timestamp</th>
                <th style="width: 90px;">Level</th>
                <th style="width: 120px;">Machine</th>
                <th>Message</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        for (const entry of pageEntries) {
            // Summary row
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';

            const machineName = entry.properties.MachineName || entry.properties.MachineName || '';

            row.innerHTML = `
                <td style="white-space: nowrap; font-size: 0.9em;">${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td>
                <td><span class="label ${levelToLabelClass(entry.level)}"${entry.level === 'Fatal' ? ' style="font-weight:bold;"' : ''}>${escapeHtml(entry.level)}</span></td>
                <td style="font-size: 0.9em;">${escapeHtml(machineName)}</td>
                <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(entry.renderedMessage)}</td>
            `;

            // Detail row (hidden by default)
            const detailRow = document.createElement('tr');
            detailRow.style.display = 'none';

            const detailCell = document.createElement('td');
            detailCell.colSpan = 4;
            detailCell.style.backgroundColor = '#f9f9f9';
            detailCell.style.padding = '12px 20px';

            let detailHtml = '';

            // Exception
            if (entry.exception) {
                detailHtml += `<div style="margin-bottom: 10px;">
                    <strong>Exception:</strong>
                    <pre style="margin-top: 4px; padding: 8px; background: #fff; border: 1px solid #ddd; border-left: 4px solid #d9534f; white-space: pre-wrap; font-size: 12px; max-height: 300px; overflow-y: auto;">${escapeHtml(entry.exception)}</pre>
                </div>`;
            }

            // Message template
            if (entry.messageTemplate) {
                detailHtml += `<div style="margin-bottom: 10px;">
                    <strong>Message Template:</strong>
                    <code style="display: block; margin-top: 4px; padding: 6px; background: #fff; border: 1px solid #ddd; word-break: break-all;">${escapeHtml(entry.messageTemplate)}</code>
                </div>`;
            }

            // Properties
            const propKeys = Object.keys(entry.properties);
            if (propKeys.length > 0) {
                detailHtml += '<div><strong>Properties:</strong>';
                detailHtml += '<table class="table table-condensed table-bordered" style="margin-top: 4px; background: #fff; font-size: 0.9em;">';
                detailHtml += '<thead><tr><th style="width: 200px;">Name</th><th>Value</th></tr></thead><tbody>';
                for (const key of propKeys) {
                    const val = entry.properties[key];
                    const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
                    detailHtml += `<tr><td><strong>${escapeHtml(key)}</strong></td><td><code>${escapeHtml(display)}</code></td></tr>`;
                }
                detailHtml += '</tbody></table></div>';
            }

            if (!detailHtml) {
                detailHtml = '<em style="color: #999;">No additional details.</em>';
            }

            detailCell.innerHTML = detailHtml;
            detailRow.appendChild(detailCell);

            // Toggle on click
            row.onclick = () => {
                const isOpen = detailRow.style.display !== 'none';
                detailRow.style.display = isOpen ? 'none' : 'table-row';
                row.style.backgroundColor = isOpen ? '' : '#f5f5f5';
            };

            tbody.appendChild(row);
            tbody.appendChild(detailRow);
        }

        table.appendChild(tbody);
        content.appendChild(table);

        // Pagination
        renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
        const container = document.getElementById('umbracolog-pagination');
        container.innerHTML = '';

        if (totalPages <= 1) return;

        const nav = document.createElement('nav');
        const ul = document.createElement('ul');
        ul.className = 'pagination';

        // Previous
        const prevLi = document.createElement('li');
        if (currentPage === 1) prevLi.className = 'disabled';
        const prevA = document.createElement('a');
        prevA.href = '#';
        prevA.innerHTML = '&laquo;';
        prevA.onclick = (e) => {
            e.preventDefault();
            if (currentPage > 1) { currentPage--; renderCurrentPage(); }
        };
        prevLi.appendChild(prevA);
        ul.appendChild(prevLi);

        // Page numbers (show max 7 pages centered around current)
        const maxVisible = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        if (startPage > 1) {
            ul.appendChild(createPageItem(1));
            if (startPage > 2) {
                const dots = document.createElement('li');
                dots.className = 'disabled';
                dots.innerHTML = '<a href="#">…</a>';
                ul.appendChild(dots);
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            ul.appendChild(createPageItem(i));
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                const dots = document.createElement('li');
                dots.className = 'disabled';
                dots.innerHTML = '<a href="#">…</a>';
                ul.appendChild(dots);
            }
            ul.appendChild(createPageItem(totalPages));
        }

        // Next
        const nextLi = document.createElement('li');
        if (currentPage === totalPages) nextLi.className = 'disabled';
        const nextA = document.createElement('a');
        nextA.href = '#';
        nextA.innerHTML = '&raquo;';
        nextA.onclick = (e) => {
            e.preventDefault();
            if (currentPage < totalPages) { currentPage++; renderCurrentPage(); }
        };
        nextLi.appendChild(nextA);
        ul.appendChild(nextLi);

        nav.appendChild(ul);
        container.appendChild(nav);
    }

    function createPageItem(page) {
        const li = document.createElement('li');
        if (page === currentPage) li.className = 'active';
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = page;
        a.onclick = (e) => {
            e.preventDefault();
            currentPage = page;
            renderCurrentPage();
        };
        li.appendChild(a);
        return li;
    }

    // --- Event listeners ---

    window.addEventListener('viewer-change', (event) => {
        if (event.detail.viewer !== VIEWER_NAME && isViewerActive) {
            isViewerActive = false;
        }
    });

    window.addEventListener('load', () => {
        addNavbarLink();

        if (window.location.search.includes(VIEWER_NAME)) {
            showViewer(true);
        }

        updateNavbarState();
    });

    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.view === VIEWER_NAME) {
            if (!isViewerActive) {
                showViewer(true);
            }
        } else if (event.state && event.state.view !== VIEWER_NAME) {
            if (isViewerActive) {
                hideViewer(true);
            }
        } else if (!event.state || !event.state.view) {
            if (isViewerActive) {
                hideViewer(true);
            }
        }

        updateNavbarState();
    });

})();
