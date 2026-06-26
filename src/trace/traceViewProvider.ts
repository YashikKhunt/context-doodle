import * as vscode from 'vscode';
import { makeNonce } from '../webviewHtml';
import { buildTraceHtml } from './traceWebviewHtml';
import { TraceBroadcaster, TraceEvent as TraceBcEvent } from './traceBroadcaster';

/**
 * Sidebar webview view that renders the Agent Trace timeline. Mirrors the
 * DoodleViewProvider lifecycle: subscribe to the broadcaster, replay last
 * known event on (re-)reveal, dispose subscriptions when the view goes away.
 */
export class TraceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextDoodle.traceView';

  private _view: vscode.WebviewView | undefined;
  private _sub: vscode.Disposable | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _broadcaster: TraceBroadcaster
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
    webviewView.webview.html = buildTraceHtml(webviewView.webview, nonce);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === 'ready') {
        this._broadcaster.replay((e) => this._post(e));
      }
    });

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

  private _post(e: TraceBcEvent): void {
    if (!this._view) return;
    if (e.kind === 'trace') {
      void this._view.webview.postMessage({ type: 'trace', model: e.model });
    } else {
      void this._view.webview.postMessage({ type: 'state', text: e.text });
    }
  }
}
