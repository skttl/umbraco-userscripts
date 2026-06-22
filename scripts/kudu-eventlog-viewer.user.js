// ==UserScript==
// @name         Kudu Event Log Viewer
// @namespace    https://github.com/skttl/umbraco-userscripts
// @version      1.1.1
// @description  Add a styled event log viewer inside Kudu for Umbraco Cloud
// @author       skttl
// @homepage     https://github.com/skttl/umbraco-userscripts
// @supportURL   https://github.com/skttl/umbraco-userscripts/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/skttl/umbraco-userscripts/main/scripts/kudu-eventlog-viewer.user.js
// @downloadURL  https://raw.githubusercontent.com/skttl/umbraco-userscripts/main/scripts/kudu-eventlog-viewer.user.js
// @include      https://*.scm.*.umbraco.io/*
// @icon         https://raw.githubusercontent.com/skttl/umbraco-userscripts/main/docs/kudu-eventlog-viewer/event_log_viewer.png
// @grant        none
// @run-at       document-end
// ==/UserScript==

    (function() {
        'use strict';

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        let isViewerActive = false;

        function addNavbarLink() {
            const navbar = document.querySelector('body > .navbar:first-child');
            if (!navbar) return;

            const navList = navbar.querySelector('.nav.navbar-nav');
            if (!navList || document.getElementById('eventlog-nav-link')) return;

            const li = document.createElement('li');
            li.id = 'eventlog-nav-link';

            const link = document.createElement('a');
            link.href = '#';
            link.textContent = 'Event Log';
            link.onclick = (e) => {
                e.preventDefault();
                toggleEventLogViewer();
            };

            li.appendChild(link);
            navList.appendChild(li);
        }

        function toggleEventLogViewer(skipHistory = false) {
            if (isViewerActive) {
                hideEventLogViewer(skipHistory);
            } else {
                showEventLogViewer(skipHistory);
            }
        }

        function showEventLogViewer(skipHistory = false) {
            const navbar = document.querySelector('body > .navbar:first-child');
            if (!navbar) return;

            const navList = navbar.querySelector('.nav.navbar-nav');
            if (navList) {
                navList.querySelectorAll('li').forEach(li => li.classList.remove('active'));
            }

            window.dispatchEvent(new CustomEvent('viewer-change', { detail: { viewer: 'eventlog' } }));

            const deploymentPanel = document.getElementById('deployment-viewer-panel');
            if (deploymentPanel) {
                deploymentPanel.style.display = 'none';
            }

            let nextSibling = navbar.nextElementSibling;
            while (nextSibling) {
                if (nextSibling.id !== 'eventlog-viewer-panel' && nextSibling.id !== 'deployment-viewer-panel') {
                    nextSibling.style.display = 'none';
                }
                nextSibling = nextSibling.nextElementSibling;
            }

            if (!document.getElementById('eventlog-viewer-panel')) {
                createViewerPanel();
                fetchEventLog();
            } else {
                document.getElementById('eventlog-viewer-panel').style.display = 'block';
            }

            isViewerActive = true;

            if (!skipHistory) {
                history.pushState({ view: 'eventlog' }, 'Event Log', window.location.pathname + '?eventlog');
            }
            
            updateNavbarState();
        }

        function hideEventLogViewer(skipHistory = false) {
            const navbar = document.querySelector('body > .navbar:first-child');
            if (!navbar) return;

            let nextSibling = navbar.nextElementSibling;
            while (nextSibling) {
                if (nextSibling.id !== 'eventlog-viewer-panel') {
                    nextSibling.style.display = '';
                }
                nextSibling = nextSibling.nextElementSibling;
            }

            const panel = document.getElementById('eventlog-viewer-panel');
            if (panel) {
                panel.style.display = 'none';
            }

            isViewerActive = false;

            if (!skipHistory) {
                history.pushState({ view: null }, '', window.location.pathname);
            }
            
            updateNavbarState();
        }

        function createViewerPanel() {
            const panel = document.createElement('div');
            panel.id = 'eventlog-viewer-panel';
            panel.className = 'container';
            panel.style.marginTop = '20px';

            const header = document.createElement('div');
            header.className = 'page-header';
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
            header.innerHTML = '<h1 style="margin:0;">Event Log Viewer</h1><span style="display:inline-flex;align-items:center;gap:10px;font-size:1rem;"><a href="https://skttl.dev" target="_blank" rel="noopener" title="skttl.dev" style="text-decoration:none;color:inherit;"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 63.7 19.1" style="height:1em;fill:currentColor;display:block;"><path d="m59.7 0-2.3 2a47.9 47.9 0 0 0-6.5 10.9q-2 1-4 1.7l-4.1 1q.7-2.4 2.1-5.3 3.3 0 5.4-.7l-.5-2.6-3.3.6 1.7-2.6-2.1-2a40 40 0 0 0-6 9.9q-2 1-4 1.7l-4.1 1q.7-2.4 2.2-5.3 3.2 0 5.4-.7l-.6-2.6-3.3.6 1.7-2.6-2.1-2a40 40 0 0 0-6 9.9q-2.6 1.3-5.4 2.2-.8-1.6-1.2-2.8l6.8-4.5-2.4-2.3a67 67 0 0 0-6.7 5.5q2.1-4.5 4.5-8.1l-2.5-1.9a90 90 0 0 0-6.4 11.9l-4 1.6-4.1-3.8a10 10 0 0 1 3.7-2.8l-.5 1.1q-.3.9-.9 1.6l2.6 2a19 19 0 0 0 2-4.4l-4-3q-1.8.4-4 2.1a12 12 0 0 0-3 3.4q.2.5.8 1l4 3.8-2.2.5-1.4-1q-.9-.6-2.5-2.4l-2.5 1.8a44 44 0 0 0 5.6 4.7 32 32 0 0 0 9-2.6l-.3.5 2.9 1.9 2.4-6.2q.3 2 1 4l3 2.2q2.4-1.2 4.8-2.6l2.8 2.6q2-.2 4.9-1.2l3-1.4 2.9 2.6q2-.1 4.9-1.2l3-1.4 2.8 2.6q1.5 0 3-.4a22 22 0 0 0 8-3.4l-.4-2.5a20 20 0 0 1-5.5 2.4q-1.6.6-4.6 1l.9-2.5q2-.5 3.7-1.3 5.1-2.8 6-9.3zm1 3q-.5 2.5-1.7 4.5-1.4 2-3.5 3a35 35 0 0 1 5.2-7.6"></path></svg></a><a href="https://github.com/sponsors/skttl" target="_blank" rel="noopener" title="Sponsor skttl on GitHub" style="text-decoration:none;">&#9829; Sponsor</a></span>';
            panel.appendChild(header);

            const btnGroup = document.createElement('div');
            btnGroup.className = 'btn-group';
            btnGroup.style.marginBottom = '20px';

            const loadBtn = document.createElement('button');
            loadBtn.className = 'btn btn-primary';
            loadBtn.textContent = 'Load Event Log';
            loadBtn.onclick = fetchEventLog;
            btnGroup.appendChild(loadBtn);

            panel.appendChild(btnGroup);

            const content = document.createElement('div');
            content.id = 'eventlog-content';
            panel.appendChild(content);

            document.body.appendChild(panel);
        }

        function levelColor(level) {
            switch(level) {
                case "2": return "#d9534f";
                case "3": return "#f0ad4e";
                case "4": return "#5bc0de";
                default: return "#999";
            }
        }

        function levelLabel(level) {
            switch(level) {
                case "2": return "danger";
                case "3": return "warning";
                case "4": return "info";
                default: return "default";
            }
        }

        function renderEvents(events) {
            const container = document.getElementById('eventlog-content');
            container.innerHTML = '';

            for (const event of events) {
                const level = event.querySelector('Level')?.textContent || '';
                const time = event.querySelector('TimeCreated')?.getAttribute('SystemTime') || '';
                const id = event.querySelector('EventID')?.textContent || '';
                const provider = event.querySelector('Provider')?.getAttribute('Name') || '';
                const computer = event.querySelector('Computer')?.textContent || '';

                const messages = [...event.querySelectorAll('EventData > Data')]
                    .map(d => `<li>${escapeHtml(d.textContent)}</li>`).join('');

                const panel = document.createElement('div');
                panel.className = `panel panel-${levelLabel(level)}`;
                panel.style.marginBottom = '15px';

                panel.innerHTML = `
                    <div class="panel-heading">
                        <h3 class="panel-title">
                            Event ${escapeHtml(id)} – ${escapeHtml(provider)}
                            <span class="pull-right" style="font-weight:normal; font-size:0.9em;">${escapeHtml(new Date(time).toLocaleString())}</span>
                        </h3>
                    </div>
                    <div class="panel-body">
                        <p><strong>Computer:</strong> ${escapeHtml(computer)}</p>
                        ${messages ? `<ul>${messages}</ul>` : ''}
                    </div>
                `;
                container.appendChild(panel);
            }
        }

        async function fetchEventLog() {
            const url = '/api/vfs/LogFiles/eventlog.xml';
            const content = document.getElementById('eventlog-content');
            content.innerHTML = '<div class="alert alert-info">Loading...</div>';

            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                const parser = new DOMParser();
                const xml = parser.parseFromString(text, 'application/xml');
                const events = [...xml.querySelectorAll('Event')];

                events.sort((a, b) => {
                    const ta = new Date(a.querySelector('TimeCreated')?.getAttribute('SystemTime'));
                    const tb = new Date(b.querySelector('TimeCreated')?.getAttribute('SystemTime'));
                    return tb - ta;
                });

                renderEvents(events);
            } catch (err) {
                content.innerHTML = `<div class="alert alert-danger">Failed to load events: ${err}</div>`;
            }
        }

        function updateNavbarState() {
            const currentState = history.state;
            const eventlogLink = document.getElementById('eventlog-nav-link');
            
            if (eventlogLink) {
                if (currentState && currentState.view === 'eventlog') {
                    eventlogLink.classList.add('active');
                } else {
                    eventlogLink.classList.remove('active');
                }
            }
        }

        window.addEventListener('viewer-change', (event) => {
            if (event.detail.viewer !== 'eventlog' && isViewerActive) {
                isViewerActive = false;
            }
        });

        window.addEventListener('load', () => {
            addNavbarLink();

            if (window.location.search.includes('eventlog')) {
                showEventLogViewer(true);
            }
            
            updateNavbarState();
        });

        window.addEventListener('popstate', (event) => {
            if (event.state && event.state.view === 'eventlog') {
                if (!isViewerActive) {
                    showEventLogViewer(true);
                }
            } else if (event.state && event.state.view !== 'eventlog') {
                if (isViewerActive) {
                    hideEventLogViewer(true);
                }
            } else if (!event.state || !event.state.view) {
                if (isViewerActive) {
                    hideEventLogViewer(true);
                }
            }
            
            updateNavbarState();
        });

    })();
