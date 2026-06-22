// ==UserScript==
// @name         Kudu Umbraco Log Viewer
// @namespace    https://github.com/skttl/umbraco-userscripts
// @version      1.4.0
// @description  View Umbraco Serilog JSON log files inside Kudu for Umbraco Cloud
// @author       skttl
// @homepage     https://github.com/skttl/umbraco-userscripts
// @supportURL   https://github.com/skttl/umbraco-userscripts/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/skttl/umbraco-userscripts/main/scripts/kudu-umbraco-log-viewer.user.js
// @downloadURL  https://raw.githubusercontent.com/skttl/umbraco-userscripts/main/scripts/kudu-umbraco-log-viewer.user.js
// @include      https://*.scm.*.umbraco.io/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const LOGS_BASE_PATH = '/api/vfs/site/wwwroot/umbraco/Logs/';
    const PAGE_SIZE = 100;
    const VIEWER_NAME = 'umbracolog';
    const SAVED_SEARCHES_KEY = 'umbracolog-saved-searches';

    let isViewerActive = false;
    let allEntries = [];
    let filteredEntries = [];
    let currentPage = 1;
    let sortDescending = true;
    let activeLevels = new Set(['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal']);
    let searchText = '';
    let queryError = null;

    // Polling state
    let pollingInterval = 0;     // seconds; 0 = off
    let pollingTimer = null;      // setTimeout handle for next reload
    let pollingCountdown = 0;     // seconds remaining
    let pollingCountdownTimer = null; // setInterval handle for countdown tick

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

    // --- Serilog-compatible query engine ---
    // Supports: @Level, @Message, @Exception, @mt, and any property name
    // Operators: =, !=, like (glob * wildcard), >, >=, <, <=
    // Logic: And / Or / Not(...)
    // Strings: single-quoted 'value'
    // Example: (Not(@Level='Verbose') and Not(@Level='Debug')) and @Message like '*timeout*'

    function entryFieldValue(entry, fieldName) {
        const n = fieldName.toLowerCase();
        if (n === '@level' || n === 'level')   return entry.level;
        if (n === '@message' || n === 'message') return entry.renderedMessage;
        if (n === '@exception' || n === 'exception') return entry.exception || '';
        if (n === '@mt' || n === 'messagetemplate') return entry.messageTemplate;
        if (n === '@t' || n === 'timestamp')   return entry.timestamp;
        // structured properties (case-insensitive lookup)
        for (const k of Object.keys(entry.properties)) {
            if (k.toLowerCase() === n) return String(entry.properties[k]);
        }
        return undefined;
    }

    function globMatch(pattern, value) {
        // Convert glob (*) pattern to regex
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp('^' + escaped + '$', 'i').test(value);
    }

    // Tokeniser
    function tokenise(expr) {
        const tokens = [];
        let i = 0;
        while (i < expr.length) {
            if (/\s/.test(expr[i])) { i++; continue; }
            if (expr[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
            if (expr[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
            if (expr[i] === "'") {
                let j = i + 1;
                while (j < expr.length && expr[j] !== "'") j++;
                tokens.push({ type: 'STRING', value: expr.slice(i + 1, j) });
                i = j + 1; continue;
            }
            // Operators: !=, >=, <=, =, >, <
            if (expr.slice(i, i + 2) === '!=') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
            if (expr.slice(i, i + 2) === '>=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
            if (expr.slice(i, i + 2) === '<=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
            if (expr[i] === '=') { tokens.push({ type: 'OP', value: '=' }); i++; continue; }
            if (expr[i] === '>') { tokens.push({ type: 'OP', value: '>' }); i++; continue; }
            if (expr[i] === '<') { tokens.push({ type: 'OP', value: '<' }); i++; continue; }
            // Identifier / keyword (@Level, MachineName, and, or, not, like, …)
            const m = expr.slice(i).match(/^[@\w]+/i);
            if (m) { tokens.push({ type: 'IDENT', value: m[0] }); i += m[0].length; continue; }
            // Fallback: skip unknown char
            i++;
        }
        return tokens;
    }

    // Recursive-descent parser → AST
    function parseQuery(expr) {
        const tokens = tokenise(expr);
        let pos = 0;

        function peek() { return tokens[pos]; }
        function consume() { return tokens[pos++]; }
        function expect(type) {
            const t = consume();
            if (!t || t.type !== type) throw new Error(`Expected ${type} at position ${pos}`);
            return t;
        }

        function parseOr() {
            let left = parseAnd();
            while (peek() && peek().type === 'IDENT' && peek().value.toLowerCase() === 'or') {
                consume();
                const right = parseAnd();
                left = { type: 'OR', left, right };
            }
            return left;
        }

        function parseAnd() {
            let left = parseUnary();
            while (peek() && peek().type === 'IDENT' && peek().value.toLowerCase() === 'and') {
                consume();
                const right = parseUnary();
                left = { type: 'AND', left, right };
            }
            return left;
        }

        function parseUnary() {
            const t = peek();
            if (t && t.type === 'IDENT' && t.value.toLowerCase() === 'not') {
                consume();
                expect('LPAREN');
                const inner = parseOr();
                expect('RPAREN');
                return { type: 'NOT', inner };
            }
            return parsePrimary();
        }

        function parsePrimary() {
            const t = peek();
            if (t && t.type === 'LPAREN') {
                consume();
                const inner = parseOr();
                expect('RPAREN');
                return inner;
            }
            // field op value
            const field = consume();
            if (!field || field.type !== 'IDENT') throw new Error(`Expected field name, got ${field ? field.value : 'EOF'}`);
            const op = consume();
            if (!op || op.type !== 'OP') {
                // Check for "like" keyword as op
                if (op && op.type === 'IDENT' && op.value.toLowerCase() === 'like') {
                    const val = consume();
                    if (!val || val.type !== 'STRING') throw new Error('Expected string after like');
                    return { type: 'CMP', field: field.value, op: 'like', value: val.value };
                }
                throw new Error(`Expected operator after ${field.value}`);
            }
            // Could be 'like' after seeing an IDENT with value 'like' — but we already handle it above.
            // op.value is =, !=, >, <, >=, <=
            const val = consume();
            if (!val || val.type !== 'STRING') throw new Error('Expected string value');
            return { type: 'CMP', field: field.value, op: op.value, value: val.value };
        }

        const ast = parseOr();
        if (pos < tokens.length) throw new Error(`Unexpected token: ${tokens[pos].value}`);
        return ast;
    }

    function evalAst(ast, entry) {
        switch (ast.type) {
            case 'AND': return evalAst(ast.left, entry) && evalAst(ast.right, entry);
            case 'OR':  return evalAst(ast.left, entry) || evalAst(ast.right, entry);
            case 'NOT': return !evalAst(ast.inner, entry);
            case 'CMP': {
                const raw = entryFieldValue(entry, ast.field);
                const entryVal = raw === undefined ? '' : String(raw);
                const cmpVal = ast.value;
                switch (ast.op) {
                    case '=':    return entryVal.toLowerCase() === cmpVal.toLowerCase();
                    case '!=':   return entryVal.toLowerCase() !== cmpVal.toLowerCase();
                    case 'like': return globMatch(cmpVal, entryVal);
                    case '>':    return entryVal > cmpVal;
                    case '>=':   return entryVal >= cmpVal;
                    case '<':    return entryVal < cmpVal;
                    case '<=':   return entryVal <= cmpVal;
                    default:     return false;
                }
            }
            default: return true;
        }
    }

    // Returns a compiled filter function or null for plain-text search
    function compileSearch(text) {
        const t = text.trim();
        if (!t) return null;
        // Detect expression syntax: contains =, Not(, and/or keywords at word boundary
        const looksLikeExpr = /[=!<>]|Not\s*\(|\band\b|\bor\b|\bnot\b|\blike\b/i.test(t);
        if (!looksLikeExpr) return null;
        return parseQuery(t); // throws on parse error
    }

    function entryMatchesSearch(entry, ast, lowerText) {
        if (ast) return evalAst(ast, entry);
        if (!lowerText) return true;
        return entry.renderedMessage.toLowerCase().includes(lowerText) ||
               entry.messageTemplate.toLowerCase().includes(lowerText);
    }

    // --- Saved searches (localStorage) ---

    function loadSavedSearches() {
        try {
            return JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveSavedSearches(list) {
        localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list));
    }

    function addSavedSearch(name, query) {
        const list = loadSavedSearches();
        const existing = list.findIndex(s => s.name === name);
        if (existing >= 0) {
            list[existing].query = query;
        } else {
            list.push({ name, query });
        }
        saveSavedSearches(list);
    }

    function deleteSavedSearch(name) {
        const list = loadSavedSearches().filter(s => s.name !== name);
        saveSavedSearches(list);
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
        stopPolling();

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
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
        header.innerHTML = '<h1 style="margin:0;">Umbraco Log Viewer</h1><span style="display:inline-flex;align-items:center;gap:10px;font-size:1rem;"><a href="https://skttl.dev" target="_blank" rel="noopener" title="skttl.dev" style="text-decoration:none;color:inherit;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 63.7 19.1" style="height:1em;fill:currentColor;display:block;"><path d="m59.7 0-2.3 2a47.9 47.9 0 0 0-6.5 10.9q-2 1-4 1.7l-4.1 1q.7-2.4 2.1-5.3 3.3 0 5.4-.7l-.5-2.6-3.3.6 1.7-2.6-2.1-2a40 40 0 0 0-6 9.9q-2 1-4 1.7l-4.1 1q.7-2.4 2.2-5.3 3.2 0 5.4-.7l-.6-2.6-3.3.6 1.7-2.6-2.1-2a40 40 0 0 0-6 9.9q-2.6 1.3-5.4 2.2-.8-1.6-1.2-2.8l6.8-4.5-2.4-2.3a67 67 0 0 0-6.7 5.5q2.1-4.5 4.5-8.1l-2.5-1.9a90 90 0 0 0-6.4 11.9l-4 1.6-4.1-3.8a10 10 0 0 1 3.7-2.8l-.5 1.1q-.3.9-.9 1.6l2.6 2a19 19 0 0 0 2-4.4l-4-3q-1.8.4-4 2.1a12 12 0 0 0-3 3.4q.2.5.8 1l4 3.8-2.2.5-1.4-1q-.9-.6-2.5-2.4l-2.5 1.8a44 44 0 0 0 5.6 4.7 32 32 0 0 0 9-2.6l-.3.5 2.9 1.9 2.4-6.2q.3 2 1 4l3 2.2q2.4-1.2 4.8-2.6l2.8 2.6q2-.2 4.9-1.2l3-1.4 2.9 2.6q2-.1 4.9-1.2l3-1.4 2.8 2.6q1.5 0 3-.4a22 22 0 0 0 8-3.4l-.4-2.5a20 20 0 0 1-5.5 2.4q-1.6.6-4.6 1l.9-2.5q2-.5 3.7-1.3 5.1-2.8 6-9.3zm1 3q-.5 2.5-1.7 4.5-1.4 2-3.5 3a35 35 0 0 1 5.2-7.6"></path></svg></a><a href="https://github.com/sponsors/skttl" target="_blank" rel="noopener" title="Sponsor skttl on GitHub" style="text-decoration:none;">&#9829; Sponsor</a></span>';
        panel.appendChild(header);

        // File picker row: [Log file:] [SELECT grows] ··· [Loading…] [Reload|v] [Download]
        const fileRow = document.createElement('div');
        fileRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:15px;';

        const fileLabel = document.createElement('label');
        fileLabel.textContent = 'Log file:';
        fileLabel.style.cssText = 'margin:0;white-space:nowrap;';
        fileRow.appendChild(fileLabel);

        const fileSelect = document.createElement('select');
        fileSelect.id = 'umbracolog-file-select';
        fileSelect.className = 'form-control';
        fileSelect.style.width = 'auto';
        fileSelect.style.flex = '1';
        fileSelect.onchange = () => loadSelectedFile();
        fileRow.appendChild(fileSelect);

        // --- Reload split-button group ---
        const reloadGroup = document.createElement('div');
        reloadGroup.className = 'btn-group';
        reloadGroup.style.flexShrink = '0';

        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'umbracolog-reload-btn';
        refreshBtn.className = 'btn btn-default';
        refreshBtn.textContent = 'Reload';
        refreshBtn.onclick = () => { stopPolling(); loadSelectedFile(); };
        reloadGroup.appendChild(refreshBtn);

        const reloadDropdownBtn = document.createElement('button');
        reloadDropdownBtn.className = 'btn btn-default dropdown-toggle';
        reloadDropdownBtn.type = 'button';
        reloadDropdownBtn.innerHTML = '<span class="caret"></span>';
        reloadDropdownBtn.title = 'Auto-reload interval';
        reloadGroup.appendChild(reloadDropdownBtn);

        const reloadMenu = document.createElement('ul');
        reloadMenu.className = 'dropdown-menu';
        reloadMenu.style.cssText = 'min-width:130px;';

        const pollOptions = [
            { label: 'Every 2 seconds',  seconds: 2 },
            { label: 'Every 5 seconds',  seconds: 5 },
            { label: 'Every 10 seconds', seconds: 10 },
            { label: 'Every 30 seconds', seconds: 30 },
            { label: 'Every 60 seconds', seconds: 60 },
        ];

        const offItem = document.createElement('li');
        offItem.id = 'umbracolog-poll-off';
        offItem.className = 'active';
        const offA = document.createElement('a');
        offA.href = '#';
        offA.textContent = 'Off';
        offA.onclick = (e) => { e.preventDefault(); stopPolling(); };
        offItem.appendChild(offA);
        reloadMenu.appendChild(offItem);

        const divItem = document.createElement('li');
        divItem.className = 'divider';
        reloadMenu.appendChild(divItem);

        for (const opt of pollOptions) {
            const li = document.createElement('li');
            li.dataset.pollSeconds = opt.seconds;
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = opt.label;
            a.onclick = (e) => { e.preventDefault(); startPolling(opt.seconds); };
            li.appendChild(a);
            reloadMenu.appendChild(li);
        }

        reloadGroup.appendChild(reloadMenu);

        // Toggle dropdown visibility
        reloadDropdownBtn.onclick = (e) => {
            e.stopPropagation();
            const open = reloadMenu.style.display === 'block';
            reloadMenu.style.display = open ? 'none' : 'block';
        };
        document.addEventListener('click', () => { reloadMenu.style.display = 'none'; });

        fileRow.appendChild(reloadGroup);

        const downloadLink = document.createElement('a');
        downloadLink.id = 'umbracolog-download-link';
        downloadLink.className = 'btn btn-default';
        downloadLink.textContent = 'Download';
        downloadLink.style.display = 'none';
        downloadLink.style.flexShrink = '0';
        fileRow.appendChild(downloadLink);

        panel.appendChild(fileRow);

        // Filter toolbar
        const toolbar = document.createElement('div');
        toolbar.id = 'umbracolog-toolbar';
        toolbar.className = 'well well-sm';
        toolbar.style.display = 'none';

        // Search input row
        const searchRow = document.createElement('div');
        searchRow.className = 'form-inline';
        searchRow.style.marginBottom = '4px';

        const searchInput = document.createElement('input');
        searchInput.id = 'umbracolog-search';
        searchInput.type = 'text';
        searchInput.className = 'form-control';
        searchInput.placeholder = "Search: text or @Level='Error' and @Message like '*timeout*'";
        searchInput.style.width = '460px';
        searchInput.style.marginRight = '6px';
        searchInput.style.fontFamily = 'monospace';
        searchInput.oninput = () => {
            searchText = searchInput.value;
            applyFilters();
            renderQueryError();
        };
        searchRow.appendChild(searchInput);

        // Save search button
        const saveSearchBtn = document.createElement('button');
        saveSearchBtn.className = 'btn btn-default btn-sm';
        saveSearchBtn.title = 'Save this search';
        saveSearchBtn.innerHTML = '&#9733; Save';
        saveSearchBtn.style.marginRight = '6px';
        saveSearchBtn.onclick = () => {
            const q = searchInput.value.trim();
            if (!q) return;
            const name = prompt('Name for this saved search:', q.length > 40 ? q.slice(0, 40) + '…' : q);
            if (!name) return;
            addSavedSearch(name, q);
            renderSavedSearches();
        };
        searchRow.appendChild(saveSearchBtn);

        const helpBtn = document.createElement('button');
        helpBtn.className = 'btn btn-default btn-sm';
        helpBtn.title = 'Query syntax help';
        helpBtn.style.marginRight = '6px';
        helpBtn.innerHTML = '?';
        helpBtn.onclick = () => showQueryHelpModal();
        searchRow.appendChild(helpBtn);

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

        // Level filter — dropdown with checkboxes
        const levelDropdownWrap = document.createElement('div');
        levelDropdownWrap.className = 'btn-group';
        levelDropdownWrap.style.cssText = 'position:relative;margin-left:6px;';

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
        searchRow.appendChild(levelDropdownWrap);

        toolbar.appendChild(searchRow);

        // Query error hint
        const queryErrorDiv = document.createElement('div');
        queryErrorDiv.id = 'umbracolog-query-error';
        queryErrorDiv.style.cssText = 'display:none;color:#a94442;font-size:12px;margin-bottom:4px;font-family:monospace;';
        toolbar.appendChild(queryErrorDiv);

        // Saved searches row
        const savedRow = document.createElement('div');
        savedRow.id = 'umbracolog-saved-searches';
        savedRow.style.cssText = 'margin-top:6px;';
        toolbar.appendChild(savedRow);

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

        // Tabbed panel: Activity graph + Common Messages
        const tabsWrapper = document.createElement('div');
        tabsWrapper.id = 'umbracolog-tabs-wrapper';
        tabsWrapper.style.cssText = 'display:none;margin-bottom:16px;';

        // Tab nav
        const tabNav = document.createElement('ul');
        tabNav.className = 'nav nav-tabs';
        tabNav.style.cssText = 'margin-bottom:0;border-bottom:1px solid #ddd;';

        const tabActivity = document.createElement('li');
        tabActivity.className = 'active';
        tabActivity.innerHTML = '<a href="#" data-tab="graph" style="padding:6px 12px;font-size:13px;">Activity</a>';

        const tabCommon = document.createElement('li');
        tabCommon.innerHTML = '<a href="#" data-tab="common" style="padding:6px 12px;font-size:13px;">Common Messages</a>';

        tabNav.appendChild(tabActivity);
        tabNav.appendChild(tabCommon);
        tabsWrapper.appendChild(tabNav);

        // Tab content area
        const tabContent = document.createElement('div');
        tabContent.style.cssText = 'border:1px solid #ddd;border-top:none;border-radius:0 0 3px 3px;padding:12px;background:#fff;';

        // Pane: graph
        const graphContainer = document.createElement('div');
        graphContainer.id = 'umbracolog-graph-container';

        const graphCanvas = document.createElement('canvas');
        graphCanvas.id = 'umbracolog-graph';
        graphCanvas.height = 80;
        graphCanvas.style.cssText = 'width:100%;height:80px;display:block;cursor:pointer;';
        graphContainer.appendChild(graphCanvas);

        const graphLegend = document.createElement('div');
        graphLegend.id = 'umbracolog-graph-legend';
        graphLegend.style.cssText = 'font-size:11px;color:#999;text-align:right;margin-top:2px;';
        graphContainer.appendChild(graphLegend);

        // Pane: common messages
        const commonMsgContainer = document.createElement('div');
        commonMsgContainer.id = 'umbracolog-common-messages';
        commonMsgContainer.style.display = 'none';

        tabContent.appendChild(graphContainer);
        tabContent.appendChild(commonMsgContainer);
        tabsWrapper.appendChild(tabContent);
        panel.appendChild(tabsWrapper);

        // Tab switching logic
        tabNav.addEventListener('click', (e) => {
            const a = e.target.closest('a[data-tab]');
            if (!a) return;
            e.preventDefault();
            const which = a.dataset.tab;
            tabNav.querySelectorAll('li').forEach(li => li.classList.remove('active'));
            a.parentElement.classList.add('active');
            graphContainer.style.display = which === 'graph' ? 'block' : 'none';
            commonMsgContainer.style.display = which === 'common' ? 'block' : 'none';
            if (which === 'graph') renderMomentumGraph();
        });

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

    // --- Polling helpers ---

    function updatePollUI() {
        const reloadBtn = document.getElementById('umbracolog-reload-btn');
        const offItem = document.getElementById('umbracolog-poll-off');

        // Update "active" highlight on menu items
        const menu = offItem ? offItem.parentElement : null;
        if (menu) {
            menu.querySelectorAll('li[data-poll-seconds]').forEach(li => {
                li.classList.toggle('active', Number(li.dataset.pollSeconds) === pollingInterval);
            });
            if (offItem) offItem.classList.toggle('active', pollingInterval === 0);
        }

        if (!reloadBtn) return;

        if (pollingInterval === 0) {
            reloadBtn.textContent = 'Reload';
        } else {
            reloadBtn.textContent = `Reloading in ${pollingCountdown}s`;
        }
    }

    function stopPolling() {
        if (pollingTimer) { clearTimeout(pollingTimer); pollingTimer = null; }
        if (pollingCountdownTimer) { clearInterval(pollingCountdownTimer); pollingCountdownTimer = null; }
        pollingInterval = 0;
        pollingCountdown = 0;
        updatePollUI();
    }

    function startPolling(seconds) {
        stopPolling();
        pollingInterval = seconds;
        pollingCountdown = seconds;
        updatePollUI();

        pollingCountdownTimer = setInterval(() => {
            pollingCountdown = Math.max(0, pollingCountdown - 1);
            const btn = document.getElementById('umbracolog-reload-btn');
            if (btn && pollingInterval > 0) {
                btn.textContent = `Reloading in ${pollingCountdown}s`;
            }
        }, 1000);

        pollingTimer = setTimeout(() => {
            scheduledReload();
        }, seconds * 1000);
    }

    async function scheduledReload() {
        if (pollingInterval === 0) return;

        // Stop the countdown ticker — loadSelectedFile will show "Loading…" and restore when done
        if (pollingCountdownTimer) { clearInterval(pollingCountdownTimer); pollingCountdownTimer = null; }

        await loadSelectedFile();

        // Re-arm if polling is still active
        if (pollingInterval > 0) {
            pollingCountdown = pollingInterval;
            updatePollUI();

            pollingCountdownTimer = setInterval(() => {
                pollingCountdown = Math.max(0, pollingCountdown - 1);
                const btn = document.getElementById('umbracolog-reload-btn');
                if (btn && pollingInterval > 0) {
                    btn.textContent = `Reloading in ${pollingCountdown}s`;
                }
            }, 1000);

            pollingTimer = setTimeout(() => {
                scheduledReload();
            }, pollingInterval * 1000);
        }
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
                .map(item => ({ name: item.name, mtime: item.mtime ? new Date(item.mtime) : new Date(0) }))
                .sort((a, b) => b.mtime - a.mtime);

            select.innerHTML = '';

            if (jsonFiles.length === 0) {
                select.innerHTML = '<option>No log files found</option>';
                return;
            }

            const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            let currentGroupKey = null;
            let currentGroup = null;

            jsonFiles.forEach(({ name, mtime }) => {
                const groupKey = mtime.getTime() === 0
                    ? 'Unknown'
                    : `${mtime.getFullYear()} ${MONTH_NAMES[mtime.getMonth()]}`;

                if (groupKey !== currentGroupKey) {
                    currentGroup = document.createElement('optgroup');
                    currentGroup.label = groupKey;
                    select.appendChild(currentGroup);
                    currentGroupKey = groupKey;
                }

                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                currentGroup.appendChild(opt);
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
        const downloadLink = document.getElementById('umbracolog-download-link');
        const reloadBtn = document.getElementById('umbracolog-reload-btn');

        if (downloadLink) {
            downloadLink.href = LOGS_BASE_PATH + encodeURIComponent(filename);
            downloadLink.download = filename;
            downloadLink.style.display = '';
        }

        if (reloadBtn) reloadBtn.textContent = 'Loading\u2026';

        content.innerHTML = '';
        toolbar.style.display = 'none';
        const tabsWrapperEl = document.getElementById('umbracolog-tabs-wrapper');
        if (tabsWrapperEl) tabsWrapperEl.style.display = 'none';
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
            renderSavedSearches();
            renderQueryError();
            applyFilters();

            if (skipped > 0) {
                console.warn(`Umbraco Log Viewer: Skipped ${skipped} malformed lines in ${filename}`);
            }
        } catch (err) {
            content.innerHTML = `<div class="alert alert-danger">Failed to load log file: ${escapeHtml(err.message)}</div>`;
        } finally {
            // Restore button text: countdown if polling is still active, otherwise "Reload"
            const btn = document.getElementById('umbracolog-reload-btn');
            if (btn) {
                btn.textContent = pollingInterval > 0 ? `Reloading in ${pollingCountdown}s` : 'Reload';
            }
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
        let ast = null;
        queryError = null;
        const t = searchText.trim();
        if (t) {
            try {
                ast = compileSearch(t);
            } catch (e) {
                queryError = e.message;
            }
        }
        const lowerSearch = (!ast && !queryError) ? t.toLowerCase() : '';

        filteredEntries = allEntries.filter(entry => {
            if (!activeLevels.has(entry.level)) return false;
            if (queryError) return false;
            return entryMatchesSearch(entry, ast, lowerSearch);
        });

        filteredEntries.sort((a, b) => {
            const ta = new Date(a.timestamp).getTime();
            const tb = new Date(b.timestamp).getTime();
            return sortDescending ? tb - ta : ta - tb;
        });

        currentPage = 1;
        renderMomentumGraph();
        renderCommonMessages();
        renderCurrentPage();
    }

    function showQueryHelpModal() {
        const existing = document.getElementById('umbracolog-help-modal');
        if (existing) { existing.style.display = 'flex'; return; }

        const overlay = document.createElement('div');
        overlay.id = 'umbracolog-help-modal';
        overlay.style.cssText = [
            'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;',
            'background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;'
        ].join('');

        const dialog = document.createElement('div');
        dialog.style.cssText = [
            'background:#fff;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,.35);',
            'width:680px;max-width:96vw;max-height:88vh;overflow-y:auto;',
            'font-family:inherit;font-size:13px;'
        ].join('');

        dialog.innerHTML = `
<div style="padding:16px 20px;border-bottom:1px solid #e5e5e5;display:flex;align-items:center;justify-content:space-between;">
  <h4 style="margin:0;font-size:15px;">Query syntax cheat sheet</h4>
  <button id="umbracolog-help-close" style="background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:#777;padding:0 4px;">&times;</button>
</div>
<div style="padding:16px 20px;">

  <p style="margin-top:0;color:#555;">Plain text is matched as a case-insensitive substring against the message. Use expressions below for structured filtering.</p>

  <h5 style="margin-bottom:6px;">Fields</h5>
  <table class="table table-condensed table-bordered" style="font-size:12px;">
    <thead><tr><th>Field</th><th>Aliases</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td><code>@Level</code></td><td><code>Level</code></td><td>Log level (Verbose, Debug, Information, Warning, Error, Fatal)</td></tr>
      <tr><td><code>@Message</code></td><td><code>Message</code></td><td>Rendered log message</td></tr>
      <tr><td><code>@Exception</code></td><td><code>Exception</code></td><td>Exception stack trace</td></tr>
      <tr><td><code>@mt</code></td><td><code>MessageTemplate</code></td><td>Raw Serilog message template</td></tr>
      <tr><td><code>@t</code></td><td><code>Timestamp</code></td><td>ISO 8601 timestamp string</td></tr>
      <tr><td><em>PropertyName</em></td><td></td><td>Any structured property (e.g. <code>MachineName</code>, <code>RequestId</code>)</td></tr>
    </tbody>
  </table>

  <h5 style="margin-bottom:6px;">Operators</h5>
  <table class="table table-condensed table-bordered" style="font-size:12px;">
    <thead><tr><th>Operator</th><th>Meaning</th><th>Example</th></tr></thead>
    <tbody>
      <tr><td><code>=</code></td><td>Case-insensitive equal</td><td><code>@Level='Error'</code></td></tr>
      <tr><td><code>!=</code></td><td>Not equal</td><td><code>@Level!='Debug'</code></td></tr>
      <tr><td><code>like</code></td><td>Glob match (<code>*</code> = any chars, <code>?</code> = one char)</td><td><code>@Message like '*timeout*'</code></td></tr>
      <tr><td><code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code></td><td>String comparison</td><td><code>@Level&gt;='Warning'</code></td></tr>
    </tbody>
  </table>

  <h5 style="margin-bottom:6px;">Boolean logic</h5>
  <table class="table table-condensed table-bordered" style="font-size:12px;">
    <thead><tr><th>Keyword</th><th>Meaning</th><th>Example</th></tr></thead>
    <tbody>
      <tr><td><code>and</code></td><td>Both conditions must be true</td><td><code>@Level='Error' and MachineName='web01'</code></td></tr>
      <tr><td><code>or</code></td><td>Either condition must be true</td><td><code>@Level='Error' or @Level='Fatal'</code></td></tr>
      <tr><td><code>Not(...)</code></td><td>Negate a condition</td><td><code>Not(@Level='Verbose')</code></td></tr>
      <tr><td><code>( )</code></td><td>Grouping</td><td><code>(@Level='Error' or @Level='Fatal') and @Message like '*sql*'</code></td></tr>
    </tbody>
  </table>

  <h5 style="margin-bottom:6px;">Examples</h5>
  <table class="table table-condensed table-bordered" style="font-size:12px;">
    <tbody>
      <tr><td style="width:56%"><code>Not(@Level='Verbose') and Not(@Level='Debug')</code></td><td>Hide noise levels</td></tr>
      <tr><td><code>@Level='Error' or @Level='Fatal'</code></td><td>Errors and fatals only</td></tr>
      <tr><td><code>@Message like '*Umbraco.Cms*'</code></td><td>Messages containing a namespace</td></tr>
      <tr><td><code>@Exception like '*SqlException*'</code></td><td>Only SQL exceptions</td></tr>
      <tr><td><code>MachineName='web-01' and @Level!='Verbose'</code></td><td>One machine, no verbose</td></tr>
      <tr><td><code>(@Level='Warning' or @Level='Error') and @Message like '*login*'</code></td><td>Login-related warnings/errors</td></tr>
    </tbody>
  </table>

  <p style="color:#888;font-size:11px;margin-bottom:0;">String values must be single-quoted. Field names and keywords are case-insensitive.</p>
</div>`;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const close = () => { overlay.style.display = 'none'; };
        document.getElementById('umbracolog-help-close').onclick = close;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
        });

        // Wire up example rows: click to insert the query
        dialog.querySelectorAll('table:last-of-type tbody tr').forEach(tr => {
            const code = tr.querySelector('code');
            if (!code) return;
            tr.style.cursor = 'pointer';
            tr.title = 'Click to use this query';
            tr.onmouseenter = () => tr.style.background = '#f5f5f5';
            tr.onmouseleave = () => tr.style.background = '';
            tr.onclick = () => {
                const input = document.getElementById('umbracolog-search');
                if (input) {
                    input.value = code.textContent;
                    searchText = code.textContent;
                    applyFilters();
                    renderQueryError();
                }
                close();
            };
        });
    }

    function renderQueryError() {
        const el = document.getElementById('umbracolog-query-error');
        if (!el) return;
        if (queryError) {
            el.textContent = '⚠ ' + queryError;
            el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    }

    function renderSavedSearches() {
        const container = document.getElementById('umbracolog-saved-searches');
        if (!container) return;
        const searches = loadSavedSearches();
        container.innerHTML = '';
        if (searches.length === 0) return;

        const label = document.createElement('span');
        label.style.cssText = 'font-size:12px;color:#777;margin-right:6px;';
        label.textContent = 'Saved:';
        container.appendChild(label);

        searches.forEach(s => {
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display:inline-block;margin-right:4px;margin-bottom:2px;';

            const btn = document.createElement('button');
            btn.className = 'btn btn-xs btn-default';
            btn.style.fontFamily = 'monospace';
            btn.textContent = s.name;
            btn.title = s.query;
            btn.onclick = () => {
                const input = document.getElementById('umbracolog-search');
                if (input) {
                    input.value = s.query;
                    searchText = s.query;
                    applyFilters();
                    renderQueryError();
                }
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-xs btn-danger';
            delBtn.style.cssText = 'margin-left:1px;padding:1px 4px;';
            delBtn.innerHTML = '&times;';
            delBtn.title = 'Delete saved search';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteSavedSearch(s.name);
                renderSavedSearches();
            };

            wrap.appendChild(btn);
            wrap.appendChild(delBtn);
            container.appendChild(wrap);
        });
    }

    function renderMomentumGraph() {
        const wrapper = document.getElementById('umbracolog-tabs-wrapper');
        const container = document.getElementById('umbracolog-graph-container');
        const canvas = document.getElementById('umbracolog-graph');
        const legend = document.getElementById('umbracolog-graph-legend');
        if (!container || !canvas || !legend) return;

        if (allEntries.length === 0) {
            if (wrapper) wrapper.style.display = 'none';
            return;
        }

        if (wrapper) wrapper.style.display = 'block';

        const timestamps = allEntries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
        if (timestamps.length === 0) { if (wrapper) wrapper.style.display = 'none'; return; }

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

        // Build bucket→page index for filtered entries
        // bucketFirstPage[i] = 1-based page number of the first filteredEntry in bucket i, or 0 if none
        const bucketFirstPage = new Array(NUM_BUCKETS).fill(0);
        for (let j = 0; j < filteredEntries.length; j++) {
            const t = new Date(filteredEntries[j].timestamp).getTime();
            if (isNaN(t)) continue;
            const idx = Math.min(NUM_BUCKETS - 1, Math.floor((t - minT) / bucketSize));
            if (!bucketFirstPage[idx]) {
                bucketFirstPage[idx] = Math.floor(j / PAGE_SIZE) + 1;
            }
        }

        // Click: navigate to the page of the first filtered entry in that bucket
        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const bucketIdx = Math.min(NUM_BUCKETS - 1, Math.floor((x / rect.width) * NUM_BUCKETS));
            const page = bucketFirstPage[bucketIdx];
            if (page) {
                currentPage = page;
                renderCurrentPage();
                document.getElementById('umbracolog-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        };

        // Floating tooltip
        let tooltip = document.getElementById('umbracolog-graph-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'umbracolog-graph-tooltip';
            tooltip.style.cssText = [
                'position:fixed;z-index:9000;pointer-events:none;display:none;',
                'background:rgba(30,30,30,0.88);color:#fff;border-radius:4px;',
                'padding:5px 9px;font-size:12px;line-height:1.5;white-space:nowrap;',
                'box-shadow:0 2px 6px rgba(0,0,0,.3);'
            ].join('');
            document.body.appendChild(tooltip);
        }

        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const bucketIdx = Math.min(NUM_BUCKETS - 1, Math.floor((x / rect.width) * NUM_BUCKETS));
            canvas.style.cursor = bucketFirstPage[bucketIdx] ? 'pointer' : 'default';

            // Redraw with hover highlight
            ctx.clearRect(0, 0, W, H);
            ctx.strokeStyle = '#e8e8e8';
            ctx.lineWidth = 1;
            for (let g = 0; g <= 4; g++) {
                const gy = H - (g / 4) * H;
                ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
            }
            for (let i = 0; i < NUM_BUCKETS; i++) {
                let yBase = H;
                if (i === bucketIdx) {
                    ctx.fillStyle = 'rgba(0,0,0,0.08)';
                    ctx.fillRect(i * barW, 0, barW, H);
                }
                for (const level of levelStack) {
                    const cnt = counts[i][level] || 0;
                    if (!cnt) continue;
                    const barH = (cnt / maxCount) * H;
                    yBase -= barH;
                    ctx.fillStyle = i === bucketIdx
                        ? shadeColor(levelColors[level] || '#999', -20)
                        : (levelColors[level] || '#999');
                    ctx.fillRect(i * barW + 0.5, yBase, Math.max(1, barW - 1), barH);
                }
            }
            if (filteredEntries.length !== allEntries.length) {
                const fCounts2 = new Array(NUM_BUCKETS).fill(0);
                for (const entry of filteredEntries) {
                    const ft = new Date(entry.timestamp).getTime();
                    if (isNaN(ft)) continue;
                    const fidx = Math.min(NUM_BUCKETS - 1, Math.floor((ft - minT) / bucketSize));
                    fCounts2[fidx]++;
                }
                ctx.strokeStyle = 'rgba(0,0,0,0.45)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 2]);
                ctx.beginPath();
                for (let i = 0; i < NUM_BUCKETS; i++) {
                    const fx = i * barW + barW / 2;
                    const fy = H - (fCounts2[i] / maxCount) * H;
                    i === 0 ? ctx.moveTo(fx, fy) : ctx.lineTo(fx, fy);
                }
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // Floating tooltip
            const bucketTotal = totals[bucketIdx];
            const bucketStart = new Date(minT + bucketIdx * bucketSize);
            const bucketEnd   = new Date(minT + (bucketIdx + 1) * bucketSize);
            const timeOpts = { hour: '2-digit', minute: '2-digit' };
            const tipTime = `${bucketStart.toLocaleTimeString([], timeOpts)} – ${bucketEnd.toLocaleTimeString([], timeOpts)}`;
            const tipCount = `${bucketTotal} msg${bucketTotal !== 1 ? 's' : ''}`;
            const tipPage = bucketFirstPage[bucketIdx] ? `<br><span style="font-size:11px;opacity:.8">click → page ${bucketFirstPage[bucketIdx]}</span>` : '';
            tooltip.innerHTML = `<strong>${tipTime}</strong>  ${tipCount}${tipPage}`;
            const ttX = e.clientX + 14;
            const ttY = e.clientY - 36;
            tooltip.style.left = ttX + 'px';
            tooltip.style.top  = ttY + 'px';
            tooltip.style.display = 'block';
            // Keep legend as the overall range summary
            legend.textContent = `${fromStr} → ${toStr}  ·  ${NUM_BUCKETS} buckets × ${bucketLabel}  ·  peak ${maxCount} msgs`;
        };

        canvas.onmouseleave = () => {
            canvas.style.cursor = 'pointer';
            if (tooltip) tooltip.style.display = 'none';
            legend.textContent = `${fromStr} → ${toStr}  ·  ${NUM_BUCKETS} buckets × ${bucketLabel}  ·  peak ${maxCount} msgs`;
            // Restore original drawing
            renderMomentumGraph();
        };

    }

    function renderCommonMessages() {
        const container = document.getElementById('umbracolog-common-messages');
        if (!container) return;

        if (allEntries.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Count occurrences of each message template across ALL loaded entries
        const counts = {};
        for (const entry of allEntries) {
            const tpl = entry.messageTemplate || entry.renderedMessage;
            if (!tpl) continue;
            counts[tpl] = (counts[tpl] || 0) + 1;
        }

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const total = sorted.length;
        const INITIAL_VISIBLE = 5;

        container.innerHTML = '';

        // Subtitle: unique count
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size:12px;color:#999;margin-bottom:6px;';
        subtitle.textContent = `${total} unique message type${total !== 1 ? 's' : ''}`;
        container.appendChild(subtitle);

        // Scrollable list container (shows top 5, rest hidden under scroll)
        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'border:1px solid #ddd;border-radius:3px;overflow:hidden;';

        const listInner = document.createElement('div');
        listInner.style.cssText = `max-height:${INITIAL_VISIBLE * 36}px;overflow-y:auto;`;

        const table = document.createElement('table');
        table.className = 'table table-condensed table-hover';
        table.style.cssText = 'margin:0;table-layout:fixed;';

        const tbody = document.createElement('tbody');

        sorted.forEach(([tpl, count]) => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.title = 'Click to filter by this message template';

            const tdMsg = document.createElement('td');
            tdMsg.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 10px;font-size:12px;';
            tdMsg.textContent = tpl;

            const tdCount = document.createElement('td');
            tdCount.style.cssText = 'width:60px;text-align:right;padding:6px 10px;font-size:12px;color:#777;white-space:nowrap;';
            tdCount.textContent = count;

            tr.appendChild(tdMsg);
            tr.appendChild(tdCount);

            tr.onmouseenter = () => { tr.style.backgroundColor = '#f5f5f5'; };
            tr.onmouseleave = () => { tr.style.backgroundColor = ''; };

            tr.onclick = () => {
                const searchInput = document.getElementById('umbracolog-search');
                if (!searchInput) return;
                const clause = `@mt='${tpl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
                const current = searchInput.value.trim();
                searchInput.value = current ? `${current} and ${clause}` : clause;
                searchText = searchInput.value;
                applyFilters();
                renderQueryError();
                searchInput.focus();
            };

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        listInner.appendChild(table);
        listWrap.appendChild(listInner);
        container.appendChild(listWrap);

        // "Show all / Show less" toggle when there are more than INITIAL_VISIBLE templates
        if (total > INITIAL_VISIBLE) {
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn btn-xs btn-link';
            toggleBtn.style.cssText = 'margin-top:4px;padding:0;font-size:12px;';
            let expanded = false;
            const rowHeight = 36;
            toggleBtn.textContent = `Show all ${total} messages`;
            toggleBtn.onclick = () => {
                expanded = !expanded;
                listInner.style.maxHeight = expanded ? `${Math.min(total, 20) * rowHeight}px` : `${INITIAL_VISIBLE * rowHeight}px`;
                toggleBtn.textContent = expanded ? 'Show fewer messages' : `Show all ${total} messages`;
            };
            container.appendChild(toggleBtn);
        }
    }

    function shadeColor(color, amount) {
        const num = parseInt(color.replace('#', ''), 16);
        const r = Math.min(255, Math.max(0, (num >> 16) + amount));
        const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
        const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
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
                <td style="white-space: nowrap; font-size: 0.9em;">${escapeHtml(machineName)}</td>
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

            // Full message
            if (entry.renderedMessage) {
                detailHtml += `<div style="margin-bottom: 10px;">
                    <strong>Message:</strong>
                    <div style="margin-top: 4px; padding: 6px; background: #fff; border: 1px solid #ddd; word-break: break-all; white-space: pre-wrap; overflow-wrap: break-word; font-size: 0.9em;">${escapeHtml(entry.renderedMessage)}</div>
                </div>`;
            }

            // Exception
            if (entry.exception) {
                detailHtml += `<div style="margin-bottom: 10px;">
                    <strong>Exception:</strong>
                    <pre style="margin-top: 4px; padding: 8px; background: #fff; border: 1px solid #ddd; border-left: 4px solid #d9534f; white-space: pre-wrap; font-size: 12px; max-height: 300px; overflow-y: auto;">${escapeHtml(entry.exception)}</pre>
                </div>`;
            }

            if (!detailHtml) {
                detailHtml = '<em style="color: #999;">No additional details.</em>';
            }

            detailCell.innerHTML = detailHtml;

            // Message template — built as DOM so it can be clicked to add to the search field
            if (entry.messageTemplate) {
                const mtDiv = document.createElement('div');
                mtDiv.style.cssText = 'margin-bottom: 10px;';

                const mtLabel = document.createElement('strong');
                mtLabel.textContent = 'Message Template:';
                mtDiv.appendChild(mtLabel);

                const mtCode = document.createElement('code');
                mtCode.textContent = entry.messageTemplate;
                mtCode.title = 'Click to filter by this message template';
                mtCode.style.cssText = 'display:block; margin-top:4px; padding:6px; background:#fff; border:1px solid #ddd; word-break:break-all; white-space:pre-wrap; overflow-wrap:break-word; cursor:pointer;';
                mtCode.onclick = (e) => {
                    e.stopPropagation();
                    const searchInput = document.getElementById('umbracolog-search');
                    if (!searchInput) return;
                    const clause = `@mt='${entry.messageTemplate.replace(/'/g, "\\'")}'`;
                    const current = searchInput.value.trim();
                    searchInput.value = current ? `${current} and ${clause}` : clause;
                    searchText = searchInput.value;
                    applyFilters();
                    renderQueryError();
                    searchInput.focus();
                };
                mtDiv.appendChild(mtCode);
                detailCell.appendChild(mtDiv);
            }

            // Properties — built as DOM so values can be clicked to add to the search field
            const propKeys = Object.keys(entry.properties);
            if (propKeys.length > 0) {
                const propsDiv = document.createElement('div');

                const propsLabel = document.createElement('strong');
                propsLabel.textContent = 'Properties:';
                propsDiv.appendChild(propsLabel);

                const propsTable = document.createElement('table');
                propsTable.className = 'table table-condensed table-bordered';
                propsTable.style.cssText = 'margin-top: 4px; background: #fff; font-size: 0.9em; table-layout: fixed; width: 100%;';

                const propsThead = document.createElement('thead');
                propsThead.innerHTML = '<tr><th style="width: 200px;">Name</th><th>Value</th></tr>';
                propsTable.appendChild(propsThead);

                const propsTbody = document.createElement('tbody');
                for (const key of propKeys) {
                    const val = entry.properties[key];
                    const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);

                    const tr = document.createElement('tr');

                    const keyTd = document.createElement('td');
                    const keyStrong = document.createElement('strong');
                    keyStrong.textContent = key;
                    keyTd.appendChild(keyStrong);

                    const valTd = document.createElement('td');
                    valTd.style.cssText = 'max-width: 0; overflow: hidden;';
                    const valCode = document.createElement('code');
                    valCode.textContent = display;
                    valCode.title = 'Click to filter by this property value';
                    valCode.style.cssText = 'cursor:pointer; word-break: break-all; white-space: pre-wrap; overflow-wrap: break-word; display: block;';
                    valCode.onclick = (e) => {
                        e.stopPropagation();
                        const searchInput = document.getElementById('umbracolog-search');
                        if (!searchInput) return;
                        const clause = `${key}='${display.replace(/'/g, "\\'")}'`;
                        const current = searchInput.value.trim();
                        searchInput.value = current ? `${current} and ${clause}` : clause;
                        searchText = searchInput.value;
                        applyFilters();
                        renderQueryError();
                        searchInput.focus();
                    };
                    valTd.appendChild(valCode);

                    tr.appendChild(keyTd);
                    tr.appendChild(valTd);
                    propsTbody.appendChild(tr);
                }
                propsTable.appendChild(propsTbody);
                propsDiv.appendChild(propsTable);
                detailCell.appendChild(propsDiv);
            }
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
            stopPolling();
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
