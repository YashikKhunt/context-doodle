import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce } from './webviewHtml';
import { FillBroadcaster, FillEvent } from './fillBroadcaster';

/**
 * A single-instance editor-area panel that hosts the same animated blob as the
 * sidebar view. The user opens it once via the `contextDoodle.openPanel`
 * command, drags it to a narrow column on the right, and from then on the
 * doodle is visible while editing — the closest VS Code allows to a
 * "floating-on-the-editor" widget.
 *
 * If the user re-runs the command while a panel exists, we just reveal it
 * rather than spawn a duplicate.
 */
export class DoodlePanelManager implements vscode.Disposable {
  private _panel: vscode.WebviewPanel | undefined;
  private _sub: vscode.Disposable | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _broadcaster: FillBroadcaster
  ) {}

  /** Open (or focus) the panel. Defaults to opening beside the active editor. */
  reveal(): void {
    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn ?? vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'contextDoodle.panel',
      'Context Doodle',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
      }
    );

    const nonce = makeNonce();
    panel.webview.html = buildWebviewHtml(panel.webview, nonce);

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') {
        this._broadcaster.replay((e) => this._post(panel, e));
      }
    });

    this._sub = this._broadcaster.onChange((e) => this._post(panel, e));

    panel.onDidDispose(() => {
      this._sub?.dispose();
      this._sub = undefined;
      this._panel = undefined;
    });

    this._panel = panel;
  }

  private _post(panel: vscode.WebviewPanel, e: FillEvent): void {
    if (e.kind === 'fill') {
      void panel.webview.postMessage({ type: 'fill', value: e.value, meta: e.meta });
    } else {
      void panel.webview.postMessage({ type: 'state', text: e.text });
    }
  }

  dispose(): void {
    this._sub?.dispose();
    this._panel?.dispose();
  }
}
