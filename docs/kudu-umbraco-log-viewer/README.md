# Kudu Umbraco Log Viewer

**File:** `scripts/kudu-umbraco-log-viewer.user.js` — v1.4.0

[![Install](https://img.shields.io/badge/Install-Userscript-blue?style=for-the-badge&logo=tampermonkey)](https://github.com/skttl/umbraco-userscripts/raw/main/scripts/kudu-umbraco-log-viewer.user.js)

Adds an Umbraco Serilog JSON log viewer inside the Kudu interface, allowing you to browse and inspect structured log files without leaving the Kudu dashboard.

![Umbraco Log Viewer](umbraco_log_viewer.png)

## Features

- **File Picker**: Lists available `.json` log files from the Umbraco Logs directory, sorted by last-write date (newest first) and grouped into `<optgroup>` sections by month (e.g. *2026 May*); a **Download** button appears once a file is loaded to save the raw log file
- **Structured Log Display**: Parses Serilog compact JSON format with expandable detail rows
- **Message Template Rendering**: Interpolates `{PropertyName}` tokens when the rendered message is absent
- **Color-Coded Level Tags**: Bootstrap labels for each log level (Verbose, Debug, Information, Warning, Error, Fatal)
- **Expandable Details**: Click any row to reveal the full message, exception stack traces, message templates, and all structured properties; **clicking a property value** adds a `PropertyName='value'` clause to the search field, and **clicking the message template** adds a `@mt='...'` clause
- **Expression Search**: Serilog-compatible query syntax (`@Level='Error' and @Message like '*timeout*'`) with automatic fallback to plain text for simple terms
- **Saved Searches**: Save, load, and delete named searches persisted to `localStorage` via a ★ Save button and inline pill buttons
- **Query Help Modal**: **?** button opens a cheat sheet covering fields, operators, boolean logic, and clickable example queries
- **Log Level Filter**: Dropdown with per-level checkboxes and Select All / None shortcuts
- **Auto-Reload / Polling**: The Reload button has a caret dropdown to enable continuous automatic reloading every 2, 5, 10, 30, or 60 seconds. While polling is active a countdown label ("Next reload in Ns") appears next to the button; it switches to "Loading…" while the fetch is in progress. Polling stops automatically when the viewer is closed or another viewer is opened.
- **Sort Toggle**: Switch between newest-first and oldest-first
- **Momentum Graph**: Stacked bar chart showing message volume across 60 time buckets for the full log span; a dashed overlay line shows the filtered subset when filters are active. Bars are **clickable** — clicking a bucket navigates to the page containing those log entries. Hovering a bar highlights it and shows a floating tooltip with the bucket's time range (e.g. `12:45 – 13:15`) and message count; if the bucket has filtered entries a `click → page N` hint is shown in the tooltip.
- **Common Log Messages**: The activity graph and common message list are presented in a two-tab panel ("Activity" / "Common Messages"). The Common Messages tab shows a ranked list of all unique message templates in the current file with occurrence counts; the top 5 are immediately visible and a "Show all N messages" toggle expands the list (scrollable, up to 20 rows). Clicking any row applies an `@mt='...'` filter, joining with `and` if a search is already active.
- **Client-Side Pagination**: 100 entries per page with full pagination controls
- **URL State Management**: Supports deep linking with `?umbracolog` query parameter
- **Browser History**: Proper back/forward navigation support

## Usage

1. Navigate to your Umbraco Cloud Kudu interface (e.g., `*.scm.euwest01.umbraco.io`)
2. Click the "Umbraco Logs" link in the navbar
3. Select a log file from the dropdown (most recent is selected by default)
4. Browse log entries — click any row to expand details
5. Use the search box to filter — type plain text for a simple contains-match, or use expressions like:
   - `@Level='Error'`
   - `Not(@Level='Verbose') and Not(@Level='Debug')`
   - `@Message like '*timeout*' or @Level='Fatal'`
   - `MachineName='web01'`
6. Click **★ Save** to persist a named search; saved searches appear as clickable pills below the search box
7. Click **?** to open the query syntax cheat sheet — example rows are clickable and apply the query directly
8. Toggle sort order with the sort button

## Technical Details

- **API Endpoints**:
  - `/api/vfs/site/wwwroot/umbraco/Logs/` — List log files (JSON directory listing)
  - `/api/vfs/site/wwwroot/umbraco/Logs/{filename}` — Fetch log file content
- **Data Format**: Serilog compact JSON (one JSON object per line)
- **Fields**: `@t` (timestamp), `@mt` (message template), `@m` (rendered message), `@l` (level), `@x` (exception), plus structured properties
- **Pagination**: Client-side, 100 entries per page

## Troubleshooting

- Check browser console for errors
- Verify the `/api/vfs/site/wwwroot/umbraco/Logs/` directory is accessible
- Ensure there are `.json` log files in the directory (Serilog compact JSON format)

## Changelog

### Unreleased
- Pending changes will be listed here before the next manual release and `@version` bump.

### 1.4.0
- **Properties table layout fix**: long property values (e.g. large JSON blobs) now wrap inside their table cell instead of overflowing and breaking the layout; the properties table uses `table-layout: fixed` so the Name column stays at a fixed width.
- **Tabbed graph/messages panel**: the activity graph and common message list are presented in a two-tab panel. The "Activity" tab shows the momentum graph; the "Common Messages" tab shows a ranked list of unique message templates with occurrence counts (top 5 visible, expandable). Clicking any row in the common messages list applies an `@mt='...'` filter.
- **Auto-Reload polling**: The Reload button is now a Bootstrap split-button group. The caret opens a dropdown to select an automatic reload interval (2 s, 5 s, 10 s, 30 s, 60 s) or turn it off. While active, a countdown label ("Next reload in Ns") is shown inline; it shows "Loading…" during the fetch. Polling stops when the viewer is closed or another viewer tab is activated.
- **Full message in expanded row**: the rendered message is now shown at the top of the expanded detail panel.
- **Clickable message template**: clicking the Message Template in the expanded detail panel appends an `@mt='...'` filter clause to the search box (joined with `and` if a query is already present) and immediately re-runs the filter.
- **No-wrap Machine column**: the Machine Name column no longer wraps.

### v1.3.0
- **Clickable property values**: clicking a value in the Properties table appends a `PropertyName='value'` filter clause to the search box (joined with `and` if a query is already present) and immediately re-runs the filter.
- **Download button**: a Download link appears next to the Reload button once a log file is loaded; clicking it triggers a browser download of the raw log file.

### v1.2.1
- Changed the `@include` from a regular expression to a glob pattern (`https://*.scm.*.umbraco.io/*`) to avoid the Tampermonkey/ESLint `avoid-regexp-include` performance warning

### v1.2.0
- **File picker grouped by month**: log files are now sorted by last-write date (newest first) and divided into `<optgroup>` sections labelled by year and month (e.g. *2026 May*), using the `mtime` field returned by the Kudu VFS directory API.
- Added **Serilog-compatible expression search**: supports `@Level`, `@Message`, `@Exception`, `@mt`, `@t`, any structured property, operators `=`, `!=`, `like` (glob `*`/`?`), `>`, `>=`, `<`, `<=`, and boolean logic `And`/`Or`/`Not(...)`. Plain-text input continues to work as a substring match.
- Added **Saved Searches**: save named queries to `localStorage`, load them with a single click, delete with ×; persisted across sessions under the key `umbracolog-saved-searches`.
- Added inline **query error hint** displayed below the search box when an expression cannot be parsed.
- Added **? query help modal**: cheat sheet covering fields, operators, boolean logic, and six clickable example queries that apply directly to the search box.
- **Momentum graph bars are now clickable**: clicking a bucket navigates to the page of log entries in that time range; hovering highlights the bar and shows a floating tooltip with the bucket time range (HH:MM – HH:MM), message count, and a `click → page N` hint when filtered entries are present.

### v1.1.0
- Replaced inline level checkboxes with a dropdown button containing per-level checkboxes and **Select All / None** shortcuts
- Added **momentum graph**: stacked bar chart (60 buckets) showing message volume over the full log timespan, with a dashed overlay line for the active filter subset

### v1.0.0
- Initial release: file picker, Serilog compact JSON parsing, expandable detail rows, search filter, level filter, sort toggle, client-side pagination, URL state management
