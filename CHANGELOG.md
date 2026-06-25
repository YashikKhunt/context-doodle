# Changelog

All notable changes to **Context Doodle** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-25

### Added

- Initial release. Watches a Cline-compatible AI-coding session and surfaces context-window usage through four ambient surfaces, all driven by a shared internal broadcaster.
- **Status bar blob**: animated unicode character (`· ∘ ○ ◌ ◎ ● ⬤`) + percent, with built-in warning/error backgrounds above 60% / 85%.
- **Sidebar webview view**: animated SVG blob that grows fatter with context fill, color-shifts blue → amber → red.
- **Editor-area panel**: same animated SVG, opened beside the active editor via `Context Doodle: Open in Editor Area` so it stays visible while coding.
- **Threshold-crossing alerts** with hysteresis. Configurable thresholds (default `[70, 90]`), severity inference (`alerts.criticalAt`, default 85), and four user-selectable alert styles: `statusBarFlash`, `activityBadge`, `blobShake`, `editorTag`.
- **Developer mode** (`contextDoodle.devMode.enabled`): replaces the on-disk Cline reader with a manual fill source and exposes six palette commands to set/sweep/bump the fill and fire alerts directly. Lets the extension be exercised without Cline running.
- Cross-platform Cline storage resolution (portable trick via `globalStorageUri` + OS-specific fallbacks for Code, Insiders, VSCodium, Cursor, etc.).
- Compatibility with Roo Code (`rooveterinaryinc.roo-cline`) and Kilo (`kilocode.kilo-code`) via `contextDoodle.targetExtensionId` — they share the same `ui_messages.json` format.
- Strict CSP with per-load nonce on the webview; no network calls, no telemetry, no external runtime dependencies.

### Known limitations

- The fill value is an approximation (`tokensIn + cacheReads` from the latest `api_req_started` event). Cline's own "context used" UI uses the same heuristic.
- VS Code's extension API does not expose a true overlay on the editor canvas; the editor-area panel is the closest available approximation.
