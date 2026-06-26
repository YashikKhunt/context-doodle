# Changelog

All notable changes to **Context Doodle** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-26

### Added

- **Agent Trace view** — a second sidebar view inside the same activity-bar container, rendering the agent's reasoning path as a vertical timeline. Header has a 7-cell stat grid (phases · LLM calls · tokens in/out · tools · errors · cost); each phase block has a stacked horizontal token bar (in/cache/out) sized to its share of the run.
- **Normalized TraceModel** — a provider-agnostic schema (TraceEvent / AgentPhase / TraceModel / Anomaly) that the parser emits. Same model drives all downstream UI and detectors; future agent flavours add only a parser entry, not a new UI.
- **Phase 9 anomaly detectors** (Tier A, always on):
  - `tool-loop` (same tool + canonicalized params repeated within a sliding window)
  - `error-storm` (≥3 errors in a window of 5 events)
  - `stall` (consecutive LLM calls with no tool/command/completion, large cumulative tokens)
  - `context-loss` (explicit truncation events or step-change in `conversationHistoryDeletedRange`)
- **Phase 10 semantic drift** (Tier B, off by default). Two interchangeable strategies behind `contextDoodle.agentTrace.driftStrategy`:
  - `embeddings` — offline Jaccard-on-stopword-filtered-terms proxy. Honest about not being real embeddings (the public extension API doesn't expose one and the extension makes no network calls).
  - `lm` — uses `vscode.lm` chat models as a judge; rate-limited; never blocks the UI; degrades gracefully when no chat model is available.
  - Either strategy adds an "On-topic NN%" tile to the header and promotes a `plan-drift` anomaly when the score drops below the threshold.
- **Export command** — `Context Doodle: Export Agent Trace as JSON…` writes the current `TraceModel` to a file the user picks.
- One disk read per poll feeds both the existing fill ratio AND the trace model — the doodle and the timeline stay in lock-step without doubling I/O.

### Changed

- Removed the now-redundant `readContextUsed` helper from `clineReader.ts`; context-used is derived from the last `llm_call` in the parsed `TraceModel`.
- Existing CHANGELOG entry for 0.1.0 retained below.

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
