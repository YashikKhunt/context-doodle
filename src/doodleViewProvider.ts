import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce } from './webviewHtml';
import { FillBroadcaster, FillEvent } from './fillBroadcaster';

/**
 * Owns the sidebar webview view. State comes from a shared FillBroadcaster —
 * the same broadcaster also drives the editor-area panel and the status bar,
 * so all three surfaces stay in sync without knowing about each other.
 *
 * On (re-)reveal we replay the last known event so the view never starts blank.
 */
export class DoodleViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextDoodle.view';

  private _view: vscode.WebviewView | undefined;
  private _sub: vscode.Disposable | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _broadcaster: FillBroadcaster
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };

    const nonce = makeNonce();
    webviewView.webview.html = buildWebviewHtml(webviewView.webview, nonce);

    // The webview asks for an initial value once its script is running.
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') {
        this._broadcaster.replay((e) => this._post(e));
      }
    });

    // Forward every subsequent event from the shared broadcaster.
    this._sub?.dispose();
    this._sub = this._broadcaster.onChange((e) => this._post(e));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._broadcaster.replay((e) => this._post(e));
    });

    webviewView.onDidDispose(() => {
      this._sub?.dispose();
      this._sub = undefined;
      this._view = undefined;
    });
  }

  private _post(e: FillEvent): void {
    if (!this._view) return;
    if (e.kind === 'fill') {
      void this._view.webview.postMessage({ type: 'fill', value: e.value, meta: e.meta });
    } else if (e.kind === 'state') {
      void this._view.webview.postMessage({ type: 'state', text: e.text });
    } else if (e.kind === 'alert') {
      if (e.styles.includes('blobShake')) {
        void this._view.webview.postMessage({
          type: 'shake',
          durationMs: e.durationMs,
          severity: e.severity
        });
      }
      if (e.styles.includes('activityBadge')) {
        this._view.badge = {
          value: e.percent,
          tooltip: `Context Doodle: crossed ${e.percent}% (${e.severity})`
        };
        // Auto-clear the badge the next time the user reveals the view.
        const view = this._view;
        const once = view.onDidChangeVisibility(() => {
          if (view.visible) {
            view.badge = undefined;
            once.dispose();
          }
        });
      }
    }
  }
}
