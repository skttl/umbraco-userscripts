# Umbraco Cloud Kudu Userscripts

A collection of userscripts that enhance the Kudu interface for Umbraco Cloud environments with additional monitoring and deployment tools.

## Scripts

### 1. Kudu Event Log Viewer

**File:** `scripts/kudu-eventlog-viewer.user.js`

[![Install](https://img.shields.io/badge/Install-Userscript-blue?style=for-the-badge&logo=tampermonkey)](https://github.com/skttl/umbraco-userscripts/raw/main/scripts/kudu-eventlog-viewer.user.js)

Adds a styled event log viewer directly inside the Kudu interface, making it easy to monitor Windows Event Logs without navigating away from the Kudu dashboard.

#### Features

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

#### Usage

1. Navigate to your Umbraco Cloud Kudu interface (e.g., `*.scm.euwest01.umbraco.io`)
2. Click the "Event Log" link in the navbar
3. Click "Load Event Log" to fetch and display events
4. Events are displayed in Bootstrap panels with full details

### 2. Umbraco Cloud Deployment Viewer

**File:** `scripts/umbraco-deployment-viewer.user.js`

[![Install](https://img.shields.io/badge/Install-Userscript-blue?style=for-the-badge&logo=tampermonkey)](https://github.com/skttl/umbraco-userscripts/raw/main/scripts/umbraco-deployment-viewer.user.js)

Provides a comprehensive deployment monitoring interface within Kudu, allowing you to track deployment status, view logs, and trigger new deployments.

#### Features

- **Deployment Dashboard**: View latest deployment status and full deployment history
- **Real-time Log Viewer**: 
  - Live deployment logs with syntax highlighting
  - Smart auto-refresh capability (5-second intervals)
    - Automatically stops when deployment reaches terminal state (Failed/Success)
    - Only refreshes during active states (Pending, Building, Deploying)
    - Updates deployment status in real-time during refresh
  - Collapsible log panel
  - Color-coded log messages (errors, warnings, success)
- **Deployment Details**:
  - Status tracking (Pending, Building, Deploying, Failed, Success)
  - Author information and commit messages
  - Timestamps (received, started, completed)
  - Duration calculation
  - Active deployment indicator
- **File Manifest Viewer**:
  - View all deployed files
  - Searchable/filterable file list
  - Organized by directory with collapsible sections
  - File count per directory
- **Deployment Triggering**: Trigger new deployments directly from the interface
- **Interactive History Table**: Click any deployment to view full details in a modal
- **URL State Management**: Supports deep linking with `?deployments` query parameter
- **Browser History**: Proper back/forward navigation support

#### Usage

1. Navigate to your Umbraco Cloud Kudu interface (e.g., `*.scm.euwest01.umbraco.io`)
2. Click the "Deployments" link in the navbar
3. View the latest deployment status and log
4. Click "Auto-refresh" to enable live log and status updates
   - Auto-refresh will automatically stop when deployment completes or fails
   - Status, duration, and completion time update in real-time
5. Click "Trigger New Deployment" to start a new deployment
6. Click on any deployment in the history table to view details
7. Click file counts to view the deployment manifest

## Installation

These scripts are designed to be used with a userscript manager browser extension.

### Prerequisites

Install a userscript manager extension for your browser:
- **Chrome/Edge**: [Tampermonkey](https://www.tampermonkey.net/)
- **Firefox**: [Tampermonkey](https://www.tampermonkey.net/) or [Greasemonkey](https://www.greasespot.net/)
- **Safari**: [Userscripts](https://github.com/quoid/userscripts)

### Installation Steps

#### Quick Install (Recommended)

1. Install a userscript manager (see prerequisites above)
2. Click the **Install** button above the script you want to install
3. Your userscript manager will open with the script ready to install
4. Click "Install" or "Confirm" in your userscript manager
5. Navigate to your Umbraco Cloud Kudu interface to see the new features

#### Manual Install

1. Install a userscript manager (see prerequisites above)
2. Click on the userscript manager icon in your browser
3. Select "Create a new script" or "Add new script"
4. Copy the contents of the desired script file from the `scripts/` folder
5. Paste into the userscript editor
6. Save the script
7. Navigate to your Umbraco Cloud Kudu interface to see the new features

## Compatibility

- **Target Environment**: Umbraco Cloud Kudu (all regions: `*.scm.*.umbraco.io`)
- **Browser Support**: All modern browsers with userscript manager support
- **Dependencies**: None (uses native browser APIs and Kudu's existing Bootstrap CSS)

## Script Coordination

Both scripts are designed to work together seamlessly:
- They communicate via custom `viewer-change` events to avoid conflicts
- Only one viewer is active at a time
- Switching between viewers properly hides/shows content
- Both support browser history navigation without interference

## Technical Details

### Event Log Viewer

- **API Endpoint**: `/api/vfs/LogFiles/eventlog.xml`
- **Data Format**: Windows Event Log XML
- **Parsing**: Uses browser's native `DOMParser`

### Deployment Viewer

- **API Endpoints**:
  - `/api/vfs/site/deployments/` - List deployments
  - `/api/vfs/site/deployments/active` - Get active deployment ID
  - `/api/vfs/site/deployments/{id}/status.xml` - Deployment status
  - `/api/vfs/site/deployments/{id}/log.log` - Deployment log
  - `/api/vfs/site/deployments/{id}/manifest` - Deployed files list
  - `/api/deployments` - Trigger new deployment (PUT)
- **Data Formats**: XML (status), plain text (logs, manifest), JSON (deployment list)
- **Auto-refresh**: 
  - 5-second polling interval when enabled
  - Fetches both log content and status.xml on each refresh
  - Automatically stops when status is not Pending, Building, or Deploying
  - Updates UI with latest status, duration, and completion time

## Troubleshooting

### Scripts not loading
- Ensure your userscript manager is enabled
- Check that the script is enabled in the userscript manager
- Verify you're on a matching URL (e.g., `*.scm.euwest01.umbraco.io`, `*.scm.useast01.umbraco.io`)
- Scripts use regex matching to support all Umbraco Cloud regions

### Event log not displaying
- Check browser console for errors
- Verify the `/api/vfs/LogFiles/eventlog.xml` endpoint is accessible
- Ensure the event log file exists on the server

### Deployment data not loading
- Check browser console for errors
- Verify API endpoints are accessible
- Check that deployments exist in `/api/vfs/site/deployments/`

## License

These userscripts are provided as-is for use with Umbraco Cloud environments.

## Version

- **Kudu Event Log Viewer**: v1.0
- **Umbraco Cloud Deployment Viewer**: v1.0
