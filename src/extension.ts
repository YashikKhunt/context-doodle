import * as vscode from 'vscode';
import { DoodleViewProvider } from './doodleViewProvider';
import { DoodlePanelManager } from './doodlePanelManager';
import { StatusBarBlob } from './statusBarBlob';
import { FillBroadcaster, FillMeta } from './fillBroadcaster';
import { findNewestTask, readContextUsed, resolveTargetStorageDir } from './clineReader';

interface Config {
  contextWindowMax: number;
  pollIntervalMs: number;
  targetExtensionId: string;
  statusBarEnabled: boolean;
  autoRevealSidebar: boolean;
  autoOpenPanel: boolean;
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('contextDoodle');
  return {
    contextWindowMax: c.get<number>('contextWindowMax', 200000),
    pollIntervalMs: c.get<number>('pollIntervalMs', 2000),
    targetExtensionId: c.get<string>('targetExtensionId', 'saoudrizwan.claude-dev'),
    statusBarEnabled: c.get<boolean>('statusBar.enabled', true),
    autoRevealSidebar: c.get<boolean>('autoRevealSidebar', false),
    autoOpenPanel: c.get<boolean>('autoOpenPanel', false)
  };
}

export function activate(context: vscode.ExtensionContext): void {
  // ----- shared state -----
  // One broadcaster fans state out to every visible surface (sidebar view,
  // editor-area panel, status bar). The poller is the only producer.
  const broadcaster = new FillBroadcaster();
  context.subscriptions.push({ dispose: () => broadcaster.dispose() });

  // ----- sidebar webview view -----
  const provider = new DoodleViewProvider(context.extensionUri, broadcaster);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DoodleViewProvider.viewType, provider, {
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

  // ----- commands -----
  context.subscriptions.push(
    vscode.commands.registerCommand('contextDoodle.revealSidebar', async () => {
      // VS Code auto-registers `<viewId>.focus` for every contributed view.
      await vscode.commands.executeCommand(`${DoodleViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('contextDoodle.openPanel', () => panelManager.reveal())
  );

  // ----- poller (rebuilt on config change) -----
  let stopPoller: (() => void) | undefined;
  const startPoller = (): void => {
    stopPoller?.();
    stopPoller = startFillPoller(context, broadcaster);
  };
  startPoller();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('contextDoodle')) return;
      syncStatusBar();
      startPoller();
    }),
    { dispose: () => stopPoller?.() }
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
  broadcaster: FillBroadcaster
): () => void {
  const cfg = readConfig();

  const target = vscode.extensions.getExtension(cfg.targetExtensionId);
  if (!target) {
    broadcaster.postState(
      `"${cfg.targetExtensionId}" not detected. Install Cline (or set contextDoodle.targetExtensionId).`
    );
    return () => undefined;
  }

  const storageRoot = resolveTargetStorageDir(context, cfg.targetExtensionId);
  if (!storageRoot) {
    broadcaster.postState(
      "Could not locate the target extension's globalStorage. Open a task in Cline once, then reload."
    );
    return () => undefined;
  }

  let lastPostedRatio: number | undefined;
  let lastGoodUsed: number | undefined;
  let lastTaskId: string | undefined;
  let disposed = false;

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
        return;
      }
      if (newest.taskId !== lastTaskId) {
        lastTaskId = newest.taskId;
        lastGoodUsed = undefined;
      }
      const used = await readContextUsed(newest.uiMessagesPath);
      if (used === undefined) {
        publishUsed(lastGoodUsed ?? 0);
        return;
      }
      lastGoodUsed = used;
      publishUsed(used);
    } catch (err) {
      console.error('[context-doodle] poll error', err);
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), cfg.pollIntervalMs);

  return (): void => {
    disposed = true;
    clearInterval(handle);
  };
}
