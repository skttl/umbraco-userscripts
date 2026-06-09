# Kudu Event Log Viewer

**File:** `scripts/kudu-eventlog-viewer.user.js` — v1.1.1

[![Install](https://img.shields.io/badge/Install-Userscript-blue?style=for-the-badge&logo=tampermonkey)](https://github.com/skttl/umbraco-userscripts/raw/main/scripts/kudu-eventlog-viewer.user.js)

Adds a styled event log viewer directly inside the Kudu interface, making it easy to monitor Windows Event Logs without navigating away from the Kudu dashboard.

![Event Log Viewer](event_log_viewer.png)

## Features

- **Navbar Integration**: Adds an "Event Log" link to the Kudu navbar
- **Event Parsing**: Parses and displays Windows Event Log XML data
- **Color-Coded Events**: Visual indicators for different event levels:
  - Error (Level 2): Red/Danger
  - Warning (Level 3): Yellow/Warning
  - Info (Level 4): Blue/Info
- **Sorted Display**: Events sorted by timestamp (newest first)
- **Event Details**: Shows event ID, provider, computer, timestamp, and messages
- **URL State Management**: Supports deep linking with `?eventlog` query parameter
- **Browser History**: Proper back/forward navigation support

## Usage

1. Navigate to your Umbraco Cloud Kudu interface (e.g., `*.scm.euwest01.umbraco.io`)
2. Click the "Event Log" link in the navbar
3. Click "Load Event Log" to fetch and display events
4. Events are displayed in Bootstrap panels with full details

## Technical Details

- **API Endpoint**: `/api/vfs/LogFiles/eventlog.xml`
- **Data Format**: Windows Event Log XML
- **Parsing**: Uses browser's native `DOMParser`

## Troubleshooting

- Check browser console for errors
- Verify the `/api/vfs/LogFiles/eventlog.xml` endpoint is accessible
- Ensure the event log file exists on the server

## Changelog

### v1.1.1
- Fixed the script not loading: switched from an invalid `@match https://*.scm.*.umbraco.io/*` pattern (mid-host wildcards are not allowed in `@match`) to a glob `@include https://*.scm.*.umbraco.io/*`

### v1.1.0
- Added proper `@author`, `@homepage`, `@supportURL`, `@license`, `@updateURL`, `@downloadURL` metadata
- Switched from `@include` regex to `@match` pattern
- Updated `@description` to mention Umbraco Cloud context

### v1.0.0
- Initial release: navbar integration, Windows Event Log XML parsing, color-coded event levels, sorted display, URL state management, browser history support
