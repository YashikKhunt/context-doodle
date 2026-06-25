# Context Doodle

A tiny VS Code companion that watches your active **Cline** AI-coding session and shows an animated blob that grows fatter as the model's context window fills up. The *size* is the signal — there are no numbers on the doodle itself (hover for the raw figure, or check the status bar).

```
   ·    ∘    ○    ◌    ◎    ●    ⬤
  empty                          full
   blue   →   amber   →   red
```

## What it does

- Reads Cline's per-task `ui_messages.json` on disk and computes
  `contextUsed ≈ tokensIn + cacheReads` from the latest `api_req_started` event.
- Maps that to a fill ratio against a configurable context-window size.
- Pushes the ratio to **four independent surfaces** so you can pick whichever fits your workflow.

The whole point is **ambient awareness** — glance and know roughly how close you are to the wall, without parsing a number.

## The four surfaces (pick your favorite, or use several)

VS Code does not let extensions paint custom SVG on top of the editor canvas. There is no public API for a HUD-style overlay. Given that constraint, the extension exposes the same fill data through four surfaces with different trade-offs:

| Surface | Always visible? | Costs space? | Animated SVG? | How to enable |
| --- | --- | --- | --- | --- |
| **Status bar blob** (`· ∘ ○ ◌ ◎ ● ⬤` + %) | ✅ yes | tiny (one item) | char-pulse + color | `contextDoodle.statusBar.enabled` (default **on**). Above 60% the segment turns **amber**, above 85% it turns **red** using VS Code's built-in warning/error backgrounds — strongest ambient signal short of a popup. |
| **Sidebar webview** (Activity Bar → Context Doodle) | only when sidebar is open and the view is selected | sidebar width | ✅ full SVG | Always contributed. Run `Context Doodle: Reveal Sidebar` or set `contextDoodle.autoRevealSidebar: true` to open it on startup. |
| **Editor-area panel** (beside-column webview, drag to a narrow strip and forget) | yes, while pinned | a column | ✅ full SVG | Run `Context Doodle: Open in Editor Area` once and drag it where you want. Set `contextDoodle.autoOpenPanel: true` to open it on activation. |
| **(Not available)** Floating overlay on the editor | — | — | — | VS Code's extension API doesn't expose this. The editor-area panel is the closest you can get. |

All four surfaces are driven by the same internal broadcaster, so they're always in sync. Disable the ones you don't want.

## How to run

1. Open this folder in VS Code.
2. `npm install`
3. Press **F5** to launch an Extension Development Host.
4. Click the Context Doodle icon in the new window's Activity Bar.
5. Open Cline in the same window and start a task — within a couple of seconds the blob will react to each message.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `contextDoodle.contextWindowMax` | `200000` | Model context-window size used to compute the fill ratio. |
| `contextDoodle.pollIntervalMs` | `2000` | How often to re-read the task file (ms). |
| `contextDoodle.targetExtensionId` | `saoudrizwan.claude-dev` | Which extension to watch. Roo Code (`rooveterinaryinc.roo-cline`) and Kilo (`kilocode.kilo-code`) use the same on-disk format, so swapping this id is all that's needed. |

## Data source

Cline (and its forks) store per-task UI event logs under VS Code's per-extension global storage:

- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\`

This extension resolves the path *portably* by deriving it from its own `context.globalStorageUri` (which lives in the same `globalStorage` directory), with the OS-specific paths above as fallback — so it works under VSCodium, Insiders, Cursor, etc. without configuration.

Inside, each task directory has a `ui_messages.json` array. Events with `say === 'api_req_started'` carry a `text` field that is itself a JSON-encoded payload of `{ tokensIn, tokensOut, cacheReads, cacheWrites, cost, apiProtocol }`. The newest such event is taken as the "current request".

## Architecture seam

A VS Code extension straddles three isolated runtimes. The boundaries matter:

```
┌──────────────────────────┐   JSON   ┌─────────────────────────┐
│  Extension Host (Node)   │ ───────► │  Webview (sandboxed)    │
│  - fs, path, vscode API  │ ◄─────── │  - no vscode, no fs     │
│  - reads ui_messages.json│ postMsg  │  - draws the SVG blob   │
└──────────────────────────┘          └─────────────────────────┘
```

- Token data is only reachable from the **host** (filesystem access).
- The animation only exists in the **webview** (DOM/SVG/rAF).
- They communicate exclusively via `postMessage` JSON. The contract is two messages:
  - host → webview: `{ type: 'fill', value: 0..1, meta?: { contextUsed, contextWindowMax, fillRatio } }`
  - host → webview: `{ type: 'state', text: '…' }` (friendly status text, e.g. "Cline not detected")
  - webview → host: `{ type: 'ready' }` so the host can replay the latest known state on re-reveal.

The CSP is locked down to `default-src 'none'` with a nonce on the one inline script — no network, no eval.

## Graceful states

| Situation | What you see |
| --- | --- |
| Cline not installed | Blob stays small with caption "…not detected" + status bar `(slash) ctx`. |
| Cline installed, no tasks yet | Blob at 0%, no errors. |
| `ui_messages.json` caught mid-write (partial JSON) | Last good value is kept, no flicker. |
| You switch tasks in Cline | Newest task by `mtime` wins; the old task's stale value is dropped on switch. |
| Sidebar hidden | Polling continues; the latest value is replayed on re-reveal. |

## Developer mode

Set `contextDoodle.devMode.enabled: true` and the extension replaces the on-disk Cline reader with a manual fill source. Six commands appear in the palette (only when dev mode is on):

| Command | What it does |
| --- | --- |
| `Context Doodle (Dev): Set Fill…` | Free-text input 0–100 |
| `Context Doodle (Dev): Pick Preset Fill…` | Pick a value from a list including the off-by-one cases (69, 71, 84, 89, 90, 95) |
| `Context Doodle (Dev): Bump Fill ±…` | ±1, ±5, ±10 |
| `Context Doodle (Dev): Sweep 0→100→0` | Auto-animated triangle wave at slow / medium / fast cadence — every threshold/color scrolls past in one go |
| `Context Doodle (Dev): Stop Sweep` | Stop the sweep |
| `Context Doodle (Dev): Fire Alert…` | Bypass the AlertEngine and fire a warning/critical alert directly so you can inspect the shake/flash/badge/tag effects in isolation |

The AlertEngine and all four surfaces work identically against the dev source, so threshold crossings, hysteresis, and severity inference all behave the same as against real Cline data.

## Limitations

- The fill is an approximation. Cline's *own* "context used" display is the source of truth; this extension uses the same heuristic but doesn't account for system-prompt tokens or tool-result overhead.
- Polling at `pollIntervalMs` (default 2s) is the baseline. A `FileSystemWatcher` could be added but isn't necessary for an ambient indicator.
- No network calls. No telemetry. No tokenizer. Just `fs.readFile` and a sine wobble.

## License

MIT.
