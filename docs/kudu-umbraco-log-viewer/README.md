# Kudu Umbraco Log Viewer

**File:** `scripts/kudu-umbraco-log-viewer.user.js` — v1.0.0

[![Install](https://img.shields.io/badge/Install-Userscript-blue?style=for-the-badge&logo=tampermonkey)](https://github.com/skttl/umbraco-userscripts/raw/main/scripts/kudu-umbraco-log-viewer.user.js)

Adds an Umbraco Serilog JSON log viewer inside the Kudu interface, allowing you to browse and inspect structured log files without leaving the Kudu dashboard.

![Umbraco Log Viewer](umbraco_log_viewer.png)

## Features

- **File Picker**: Lists available `.json` log files from the Umbraco Logs directory, sorted newest first
- **Structured Log Display**: Parses Serilog compact JSON format with expandable detail rows
- **Message Template Rendering**: Interpolates `{PropertyName}` tokens when the rendered message is absent
- **Color-Coded Level Tags**: Bootstrap labels for each log level (Verbose, Debug, Information, Warning, Error, Fatal)
- **Expandable Details**: Click any row to reveal exception stack traces, message templates, and all structured properties
- **Search Filter**: Case-insensitive text search across rendered messages
- **Log Level Filter**: Checkboxes to show/hide entries by level
- **Sort Toggle**: Switch between newest-first and oldest-first
- **Client-Side Pagination**: 100 entries per page with full pagination controls
- **URL State Management**: Supports deep linking with `?umbracolog` query parameter
- **Browser History**: Proper back/forward navigation support

## Usage

1. Navigate to your Umbraco Cloud Kudu interface (e.g., `*.scm.euwest01.umbraco.io`)
2. Click the "Umbraco Logs" link in the navbar
3. Select a log file from the dropdown (most recent is selected by default)
4. Browse log entries — click any row to expand details
5. Use the search box and level checkboxes to filter entries
6. Toggle sort order with the sort button

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
