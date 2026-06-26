import * as vscode from 'vscode';
import { DoodleViewProvider } from './doodleViewProvider';
import { DoodlePanelManager } from './doodlePanelManager';
import { StatusBarBlob } from './statusBarBlob';
import { FillBroadcaster, FillMeta, AlertSeverity, AlertStyle } from './fillBroadcaster';
import { AlertEngine } from './alertEngine';
import { EditorTagDecorator } from './editorTagDecorator';
import { DevFillSource } from './devFillSource';
import { findNewestTask, resolveTargetStorageDir } from './clineReader';
import { TraceBroadcaster } from './trace/traceBroadcaster';
import { TraceViewProvider } from './trace/traceViewProvider';
import { parseTrace } from './trace/parser';
import { detectAnomalies } from './trace/anomalies';
import { DriftChecker, DriftStrategy, makeDriftChecker } from './trace/driftCheck';
import * as fs from 'fs/promises';

interface Config {
  contextWindowMax: number;
  pollIntervalMs: number;
  targetExtensionId: string;
  statusBarEnabled: boolean;
  autoRevealSidebar: boolean;
  autoOpenPanel: boolean;
  alertThresholds: number[];
  alertStyles: AlertStyle[];
  alertFlashDurationMs: number;
  alertHysteresisMargin: number;
  alertCriticalAt: number;
  devModeEnabled: boolean;
  driftStrategy: DriftStrategy;
  driftThreshold: number;
  driftCheckIntervalMs: number;
}

const ALL_ALERT_STYLES: AlertStyle[] = ['statusBarFlash', 'activityBadge', 'blobShake', 'editorTag'];

function sanitizeThresholds(raw: unknown): number[] {
  // Accept e.g. [70, 90] or ["70", "90"]; clamp to (0, 100); de-dupe; sort ascending.
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned = arr
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
  return Array.from(new Set(cleaned)).sort((a, b) => a - b);
}

function sanitizeStyles(raw: unknown): AlertStyle[] {
  const arr = Array.isArray(raw) ? raw : [];
  const set = new Set<AlertStyle>();
  for (const v of arr) {
    if (typeof v === 'string' && (ALL_ALERT_STYLES as string[]).includes(v)) {
      set.add(v as AlertStyle);
    }
  }
  return Array.from(set);
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('contextDoodle');
  return {
    contextWindowMax: c.get<number>('contextWindowMax', 200000),
    pollIntervalMs: c.get<number>('pollIntervalMs', 2000),
    targetExtensionId: c.get<string>('targetExtensionId', 'saoudrizwan.claude-dev'),
    statusBarEnabled: c.get<boolean>('statusBar.enabled', true),
    autoRevealSidebar: c.get<boolean>('autoRevealSidebar', false),
    autoOpenPanel: c.get<boolean>('autoOpenPanel', false),
    alertThresholds: sanitizeThresholds(c.get('alerts.thresholds', [70, 90])),
    alertStyles: sanitizeStyles(c.get('alerts.styles', ALL_ALERT_STYLES)),
    alertFlashDurationMs: c.get<number>('alerts.flashDurationMs', 2000),
    alertHysteresisMargin: c.get<number>('alerts.hysteresisMargin', 5),
    alertCriticalAt: c.get<number>('alerts.criticalAt', 85),
    devModeEnabled: c.get<boolean>('devMode.enabled', false),
    driftStrategy: sanitizeDriftStrategy(c.get('agentTrace.driftStrategy', 'off')),
    driftThreshold: c.get<number>('agentTrace.driftThreshold', 0.15),
    driftCheckIntervalMs: c.get<number>('agentTrace.driftCheckIntervalMs', 30000)
  };
}

function sanitizeDriftStrategy(v: unknown): DriftStrategy {
  return v === 'embeddings' || v === 'lm' ? v : 'off';
}

export function activate(context: vscode.ExtensionContext): void {
  // ----- shared state -----
  // Two broadcasters: one for the lightweight fill ratio (drives doodle +
  // status bar + alerts), one for the heavier parsed TraceModel (drives the
  // Agent Trace timeline). Kept separate because they have very different
  // payload sizes and don't need to update on the same cadence.
  const broadcaster = new FillBroadcaster();
  const traceBroadcaster = new TraceBroadcaster();
  context.subscriptions.push({ dispose: () => broadcaster.dispose() });
  context.subscriptions.push({ dispose: () => traceBroadcaster.dispose() });

  // ----- sidebar webview view -----
  const provider = new DoodleViewProvider(context.extensionUri, broadcaster);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DoodleViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ----- Agent Trace view (Phase 7) -----
  const traceProvider = new TraceViewProvider(context.extensionUri, traceBroadcaster);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TraceViewProvider.viewType, traceProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ----- editor-area panel (opens on command) -----
  const panelManager = new DoodlePanelManager(context.extensionUri, broadcaster);
  context.subscriptions.push(panelManager);

  // ----- status bar (rebuilt on config change) -----
  let statusBar: StatusBarBlob | undefined;
  const syncStatusBar = (): void => {
    const cfg = readConfig();
    if (cfg.statusBarEnabled && !statusBar) {
      statusBar = new StatusBarBlob(broadcaster);
    } else if (!cfg.statusBarEnabled && statusBar) {
      statusBar.dispose();
      statusBar = undefined;
    }
  };
  syncStatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // ----- editor inline-tag decorator (always subscribed; gated by alert.styles) -----
  const editorDecorator = new EditorTagDecorator(broadcaster);
  context.subscriptions.push(editorDecorator);

  // ----- alert engine (rebuilt on config change) -----
  let stopAlerts: (() => void) | undefined;
  const syncAlertEngine = (): void => {
    stopAlerts?.();
    const cfg = readConfig();
    if (cfg.alertThresholds.length === 0 || cfg.alertStyles.length === 0) {
      // User disabled alerts — no engine, nothing fires.
      stopAlerts = undefined;
      return;
    }
    const engine = new AlertEngine(
      broadcaster,
      cfg.alertThresholds,
      cfg.alertHysteresisMargin,
      cfg.alertCriticalAt
    );
    const sub = engine.onAlert(({ percent, severity }) => {
      broadcaster.postAlert(percent, severity, cfg.alertFlashDurationMs, cfg.alertStyles);
    });
    stopAlerts = (): void => {
      sub.dispose();
      engine.dispose();
    };
  };
  syncAlertEngine();
  context.subscriptions.push({ dispose: () => stopAlerts?.() });

  // ----- commands -----
  context.subscriptions.push(
    vscode.commands.registerCommand('contextDoodle.revealSidebar', async () => {
      // VS Code auto-registers `<viewId>.focus` for every contributed view.
      await vscode.commands.executeCommand(`${DoodleViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('contextDoodle.openPanel', () => panelManager.reveal()),

    // Phase 11: export the currently displayed TraceModel to a local JSON
    // file. Read-only by design — never writes into the watched extension's
    // storage; only writes a fresh file the user explicitly picks.
    vscode.commands.registerCommand('contextDoodle.trace.exportJson', async () => {
      const model = traceBroadcaster.getLastModel();
      if (!model) {
        void vscode.window.showInformationMessage(
          'Context Doodle: no trace data yet — open an active Cline task first.'
        );
        return;
      }
      const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        title: 'Export Agent Trace',
        defaultUri: defaultUri
          ? vscode.Uri.joinPath(defaultUri, `agent-trace-${model.taskId}.json`)
          : vscode.Uri.file(`agent-trace-${model.taskId}.json`),
        filters: { JSON: ['json'] }
      });
      if (!target) return;
      const json = JSON.stringify(model, null, 2);
      await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
      void vscode.window.showInformationMessage(
        `Context Doodle: exported trace (${model.phases.length} phases, ${model.totals.llmCalls} LLM calls) to ${target.fsPath}`
      );
    })
  );

  // ----- fill source: real poller OR developer mock (rebuilt on config change) -----
  // In dev mode we replace the on-disk Cline poller with a manual source so
  // the extension can be exercised without Cline running. The dev source is
  // exposed via the commands below; the AlertEngine and all four surfaces
  // react identically regardless of which source is producing values.
  let stopSource: (() => void) | undefined;
  let devSource: DevFillSource | undefined;
  const startSource = (): void => {
    stopSource?.();
    devSource = undefined;
    const cfg = readConfig();
    if (cfg.devModeEnabled) {
      const dev = new DevFillSource(broadcaster, cfg.contextWindowMax);
      devSource = dev;
      traceBroadcaster.postState(
        'Developer mode is on. Trace view shows real data only when devMode is off.'
      );
      stopSource = (): void => {
        dev.dispose();
      };
    } else {
      stopSource = startFillPoller(context, broadcaster, traceBroadcaster);
    }
  };
  startSource();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('contextDoodle')) return;
      syncStatusBar();
      syncAlertEngine();
      startSource();
    }),
    { dispose: () => stopSource?.() }
  );

  // ----- dev mode commands (only meaningful when contextDoodle.devMode.enabled) -----
  // Command palette visibility is gated by the `when` clauses in package.json,
  // so end users never see these in normal use. We still register them
  // unconditionally so the gating clause can refer to them.
  const requireDev = (): DevFillSource | undefined => {
    if (!devSource) {
      void vscode.window.showInformationMessage(
        'Context Doodle: enable contextDoodle.devMode.enabled to use dev commands.'
      );
      return undefined;
    }
    return devSource;
  };

  const presetFills = [0, 25, 50, 60, 65, 69, 70, 71, 80, 84, 85, 89, 90, 95, 100];

  context.subscriptions.push(
    vscode.commands.registerCommand('contextDoodle.dev.setFill', async () => {
      const dev = requireDev();
      if (!dev) return;
      const input = await vscode.window.showInputBox({
        title: 'Context Doodle (dev): set fill %',
        value: String(dev.currentPercent),
        prompt: 'Enter a percent value 0–100',
        validateInput: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'Enter 0–100';
        }
      });
      if (input === undefined) return;
      dev.setFill(Number(input));
    }),

    vscode.commands.registerCommand('contextDoodle.dev.pickFill', async () => {
      const dev = requireDev();
      if (!dev) return;
      const pick = await vscode.window.showQuickPick(
        presetFills.map((p) => ({ label: `${p}%`, value: p })),
        { title: 'Context Doodle (dev): pick a preset fill' }
      );
      if (!pick) return;
      dev.setFill(pick.value);
    }),

    vscode.commands.registerCommand('contextDoodle.dev.bump', async () => {
      const dev = requireDev();
      if (!dev) return;
      const pick = await vscode.window.showQuickPick(
        ['+1', '+5', '+10', '-1', '-5', '-10'].map((l) => ({ label: l, value: Number(l) })),
        { title: 'Context Doodle (dev): bump fill by…' }
      );
      if (!pick) return;
      dev.bump(pick.value);
    }),

    vscode.commands.registerCommand('contextDoodle.dev.sweep', async () => {
      const dev = requireDev();
      if (!dev) return;
      if (dev.isSweeping()) {
        dev.stopSweep();
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Slow (40s/cycle)', value: 40000 },
          { label: 'Medium (20s/cycle)', value: 20000 },
          { label: 'Fast (10s/cycle)', value: 10000 }
        ],
        { title: 'Context Doodle (dev): sweep speed' }
      );
      if (!pick) return;
      dev.startSweep(pick.value);
    }),

    vscode.commands.registerCommand('contextDoodle.dev.stopSweep', () => {
      devSource?.stopSweep();
    }),

    vscode.commands.registerCommand('contextDoodle.dev.fireAlert', async () => {
      const dev = requireDev();
      if (!dev) return;
      const sevPick = await vscode.window.showQuickPick(
        [
          { label: 'warning (amber, gentle shake)', value: 'warning' as AlertSeverity },
          { label: 'critical (red, violent shake)', value: 'critical' as AlertSeverity }
        ],
        { title: 'Context Doodle (dev): fire alert — pick severity' }
      );
      if (!sevPick) return;
      const pctInput = await vscode.window.showInputBox({
        title: 'Context Doodle (dev): alert percent label',
        value: sevPick.value === 'critical' ? '90' : '70',
        prompt: 'Percent label to show in the badge / editor tag',
        validateInput: (v) =>
          Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 100 ? null : 'Enter 1–99'
      });
      if (pctInput === undefined) return;
      const cfg = readConfig();
      const styles: AlertStyle[] = cfg.alertStyles.length
        ? cfg.alertStyles
        : ['statusBarFlash', 'activityBadge', 'blobShake', 'editorTag'];
      dev.fireAlert(Number(pctInput), sevPick.value, styles, cfg.alertFlashDurationMs);
    })
  );

  // ----- auto-open behaviors (off by default) -----
  const cfg = readConfig();
  if (cfg.autoRevealSidebar) {
    void vscode.commands.executeCommand('contextDoodle.revealSidebar');
  }
  if (cfg.autoOpenPanel) {
    panelManager.reveal();
  }
}

export function deactivate(): void {
  // Subscriptions handle cleanup.
}

/**
 * Polling loop that reads the watched extension's latest task and pushes a
 * fill ratio to the broadcaster. Returns a stop function.
 *
 * Design notes:
 *  - Polling beats a FileSystemWatcher here because ui_messages.json is rewritten
 *    in-place (often atomically via rename), and watchers across platforms are
 *    inconsistent for that pattern. The ~2s default is plenty for ambient.
 *  - Debounce by VALUE: only post when fillRatio changes meaningfully.
 *  - On unreadable / mid-write reads we keep the last good fill instead of
 *    flickering to 0.
 *  - On task switch (newest task id changes) we drop last-good so a stale
 *    ratio from the previous task can't bleed into the new one.
 */
function startFillPoller(
  context: vscode.ExtensionContext,
  broadcaster: FillBroadcaster,
  traceBroadcaster: TraceBroadcaster
): () => void {
  const cfg = readConfig();

  const target = vscode.extensions.getExtension(cfg.targetExtensionId);
  if (!target) {
    const msg = `"${cfg.targetExtensionId}" not detected. Install Cline (or set contextDoodle.targetExtensionId).`;
    broadcaster.postState(msg);
    traceBroadcaster.postState(msg);
    return () => undefined;
  }

  const storageRoot = resolveTargetStorageDir(context, cfg.targetExtensionId);
  if (!storageRoot) {
    const msg = "Could not locate the target extension's globalStorage. Open a task in Cline once, then reload.";
    broadcaster.postState(msg);
    traceBroadcaster.postState(msg);
    return () => undefined;
  }

  let lastPostedRatio: number | undefined;
  let lastGoodUsed: number | undefined;
  let lastTaskId: string | undefined;
  let lastTraceMtime: number | undefined;
  let disposed = false;
  // Tier B: live drift checker, lazily constructed. We hold the latest model
  // here so an async drift result can be re-attached + re-broadcast without
  // needing another disk read.
  const driftChecker: DriftChecker | undefined = makeDriftChecker(
    cfg.driftStrategy,
    cfg.driftCheckIntervalMs
  );
  let latestModel: import('./trace/types').TraceModel | undefined;

  const publishUsed = (used: number): void => {
    const max = Math.max(1, cfg.contextWindowMax);
    const ratio = Math.min(1, used / max);
    if (lastPostedRatio !== undefined && Math.abs(ratio - lastPostedRatio) < 0.0005) return;
    lastPostedRatio = ratio;
    const meta: FillMeta = { contextUsed: used, contextWindowMax: max, fillRatio: ratio };
    broadcaster.postFill(ratio, meta);
  };

  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      const newest = await findNewestTask(storageRoot);
      if (!newest) {
        publishUsed(0);
        traceBroadcaster.postState('No active task yet.');
        return;
      }
      if (newest.taskId !== lastTaskId) {
        lastTaskId = newest.taskId;
        lastGoodUsed = undefined;
        lastTraceMtime = undefined; // force re-publish on task switch
      }

      // ONE disk read serves both channels: parse the array once, derive
      // the fill ratio from the last llm_call, hand the model to the trace
      // broadcaster (which dedupes on mtime).
      let raw: string;
      try {
        raw = await fs.readFile(newest.uiMessagesPath, 'utf8');
      } catch {
        publishUsed(lastGoodUsed ?? 0);
        return;
      }
      let arr: unknown;
      try {
        arr = JSON.parse(raw);
      } catch {
        // Partial mid-write — keep last good fill, don't re-publish trace.
        publishUsed(lastGoodUsed ?? 0);
        return;
      }

      const model = parseTrace({
        taskId: newest.taskId,
        raw: arr,
        sourceMtimeMs: newest.mtimeMs
      });
      // Detectors are pure functions over the parsed model — running them
      // post-parse keeps the parser stripped of policy concerns.
      model.anomalies = detectAnomalies(model);

      // Derive context-used from the LAST llm_call in the model — matches
      // the old `readContextUsed` semantics without a second pass.
      const lastLlm = [...model.phases.flatMap((p) => p.events)]
        .reverse()
        .find((e) => e.kind === 'llm_call');
      const used = lastLlm
        ? (lastLlm.tokensIn ?? 0) + (lastLlm.cacheReads ?? 0)
        : 0;
      lastGoodUsed = used;
      publishUsed(used);

      // Carry forward the most recent drift result (if any) so the UI
      // doesn't lose it on a non-drift-related re-poll.
      if (latestModel?.drift && latestModel.taskId === model.taskId) {
        model.drift = latestModel.drift;
        maybePromoteDriftToAnomaly(model, cfg.driftThreshold);
      }
      latestModel = model;

      // Debounce trace updates on mtime; the broadcaster checks equality.
      if (lastTraceMtime !== newest.mtimeMs && traceBroadcaster.shouldRepublish(model)) {
        lastTraceMtime = newest.mtimeMs;
        traceBroadcaster.postTrace(model);
      }

      // Tier B: kick off (or refresh) the drift check. The checker handles
      // its own rate limiting; we don't await it here so the poll stays
      // snappy. When a fresh result arrives, re-attach + re-broadcast.
      if (driftChecker) {
        void driftChecker
          .check(model)
          .then((res) => {
            if (disposed || !res || !latestModel || latestModel.taskId !== model.taskId) return;
            const prevScore = latestModel.drift?.score;
            latestModel.drift = res;
            maybePromoteDriftToAnomaly(latestModel, cfg.driftThreshold);
            // Re-broadcast only if the score actually changed meaningfully.
            if (prevScore === undefined || Math.abs(prevScore - res.score) > 0.02) {
              traceBroadcaster.postTrace(latestModel);
            }
          })
          .catch(() => undefined);
      }
    } catch (err) {
      console.error('[context-doodle] poll error', err);
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), cfg.pollIntervalMs);

  return (): void => {
    disposed = true;
    driftChecker?.dispose();
    clearInterval(handle);
  };
}

/** If the drift score is below the threshold, surface it as a plan-drift
 *  anomaly so it appears in the Flags band alongside Tier-A findings. */
function maybePromoteDriftToAnomaly(
  model: import('./trace/types').TraceModel,
  threshold: number
): void {
  if (!model.drift) return;
  // Drop any prior plan-drift anomaly first — score may have recovered.
  model.anomalies = model.anomalies.filter((a) => a.type !== 'plan-drift');
  if (model.drift.score >= threshold) return;
  model.anomalies.push({
    type: 'plan-drift',
    severity: model.drift.score < threshold / 2 ? 'critical' : 'warning',
    atTs: model.sourceMtimeMs ?? Date.now(),
    evidence: [],
    message: `Drift score ${Math.round(model.drift.score * 100)}% — ${model.drift.reason}`
  });
}
