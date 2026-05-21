# Agent Guide — umbraco-userscripts

## Project overview

A collection of Tampermonkey userscripts that enhance the Kudu interface for Umbraco Cloud environments.

- `scripts/kudu-eventlog-viewer.user.js` — Adds an Event Log viewer tab to the Kudu navbar
- `scripts/umbraco-deployment-viewer.user.js` — Adds a Deployment monitoring/triggering tab to the Kudu navbar
- `scripts/kudu-umbraco-log-viewer.user.js` — Adds an Umbraco Serilog JSON log viewer tab to the Kudu navbar

## Repository layout

```
scripts/          Userscript source files (*.user.js)
docs/             Per-script documentation with screenshots co-located
.agents/          Agent-specific assets (empty by default)
skills-lock.json  Pinned agent skill versions
```

## Coding conventions

- Each script is a **single self-contained IIFE** — no build step, no bundler, no npm.
- Metadata block at the top follows the [Tampermonkey / UserScript spec](https://www.tampermonkey.net/documentation.php).
- Scripts use **only native browser APIs** and Kudu's existing Bootstrap 3 CSS — no external libraries.
- Scripts communicate with each other via a custom DOM event: `viewer-change` dispatched on `window`.
- URL state is managed via `history.pushState` / `popstate` using query parameters (`?eventlog`, `?deployments`).
- `@grant none` — no GM API calls.

## Target environment

- **URL pattern**: `https://*.scm.*.umbraco.io/*`  
- Kudu provides Bootstrap 3 CSS globally; scripts rely on `.navbar`, `.container`, `.panel-*`, `.btn-*` classes.
- API endpoints are same-origin Kudu REST endpoints (e.g. `/api/vfs/...`, `/api/deployments`).

## Making changes

1. Edit the relevant `scripts/*.user.js` file directly.
2. Bump `@version` in the metadata block for any functional change.
3. Keep each script self-contained — do not introduce external dependencies or a build pipeline.
4. Keep `README.md` in sync: update feature lists, version numbers, and any technical details (API endpoints, URL patterns, compatibility notes) whenever the scripts change.
5. If adding a new viewer, follow the existing pattern:
   - Add a navbar `<li>` link
   - Dispatch `viewer-change` when activating
   - Listen for `viewer-change` to deactivate when another viewer opens
   - Manage URL state with `history.pushState` and `?<viewer>` query parameter

## Testing

There is no automated test suite. Verify changes by:

1. Loading the script in Tampermonkey (or via a local `@require` path).
2. Navigating to a Umbraco Cloud Kudu URL matching the `@include` pattern.
3. Exercising the navbar links, deep-link URLs, and browser back/forward navigation.
4. Checking the browser console for errors.

## Keeping this file up to date

This file is the agent's primary source of truth for the project. Update it whenever:

- A new script is added or removed from `scripts/`
- Coding conventions, URL patterns, or API endpoints change
- New viewers or features introduce patterns that future agents should follow
- The testing approach or out-of-scope boundaries change

Keep edits minimal and factual — reflect reality, don't prescribe aspirations.

## Out of scope

- Do not introduce a bundler, transpiler, or `package.json`.
- Do not add external CDN dependencies to the scripts.
- When adding or updating screenshots for a script, place them in the corresponding `docs/<script-name>/` subdirectory.
