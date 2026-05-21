# Kudu Event Log Viewer

**File:** `scripts/kudu-eventlog-viewer.user.js` — v1.1.0

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
