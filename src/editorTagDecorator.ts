import * as vscode from 'vscode';
import { AlertSeverity, FillBroadcaster } from './fillBroadcaster';

/**
 * Renders a small `[ctx 90%]` tag at the end of the active editor's cursor
 * line for the duration of an alert, then clears it.
 *
 * Implementation notes:
 *  - Uses `after`-content decorations, which sit at end-of-line and don't
 *    perturb file contents. They're cleared by setting an empty ranges array
 *    on the decoration type. We dispose the type entirely when the alert
 *    ends — cheaper than keeping a long-lived "currently inactive" type around.
 *  - If the user switches editors during the alert window, we re-apply the
 *    decoration to the new active editor so the indicator follows them.
 *  - If no text editor is active (e.g. only a webview tab is focused), the
 *    alert is silently dropped for this surface — not an error.
 */
export class EditorTagDecorator implements vscode.Disposable {
  private readonly _sub: vscode.Disposable;
  private readonly _editorSub: vscode.Disposable;
  private _activeAlert:
    | { decoration: vscode.TextEditorDecorationType; deadlineMs: number; clearTimer: NodeJS.Timeout }
    | undefined;

  constructor(broadcaster: FillBroadcaster) {
    this._sub = broadcaster.onChange((e) => {
      if (e.kind !== 'alert') return;
      if (!e.styles.includes('editorTag')) return;
      this._showAlert(e.percent, e.severity, e.durationMs);
    });

    // Follow the user to whichever editor they look at next during an alert.
    this._editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !this._activeAlert) return;
      this._applyTo(editor, this._activeAlert.decoration);
    });
  }

  private _showAlert(percent: number, severity: AlertSeverity, durationMs: number): void {
    this._clearActive();

    const colorToken =
      severity === 'critical' ? 'errorForeground' : 'editorWarning.foreground';

    const decoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` [ctx ${percent}%]`,
        color: new vscode.ThemeColor(colorToken),
        margin: '0 0 0 2em',
        fontStyle: 'italic'
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    const editor = vscode.window.activeTextEditor;
    if (editor) this._applyTo(editor, decoration);

    const clearTimer = setTimeout(() => {
      decoration.dispose();
      this._activeAlert = undefined;
    }, Math.max(200, durationMs));

    this._activeAlert = { decoration, deadlineMs: Date.now() + durationMs, clearTimer };
  }

  private _applyTo(editor: vscode.TextEditor, decoration: vscode.TextEditorDecorationType): void {
    // Decorate the line containing the cursor's primary position. The `after`
    // content renders at end-of-line regardless of where in the line we anchor.
    const pos = editor.selection.active;
    editor.setDecorations(decoration, [new vscode.Range(pos, pos)]);
  }

  private _clearActive(): void {
    if (!this._activeAlert) return;
    clearTimeout(this._activeAlert.clearTimer);
    this._activeAlert.decoration.dispose();
    this._activeAlert = undefined;
  }

  dispose(): void {
    this._clearActive();
    this._sub.dispose();
    this._editorSub.dispose();
  }
}
