import * as vscode from 'vscode';

export interface FillMeta {
  contextUsed: number;
  contextWindowMax: number;
  fillRatio: number;
}

export type AlertSeverity = 'warning' | 'critical';
export type AlertStyle = 'statusBarFlash' | 'activityBadge' | 'blobShake' | 'editorTag';

export type FillEvent =
  | { kind: 'fill'; value: number; meta: FillMeta }
  | { kind: 'state'; text: string }
  // Threshold-crossing alert. The `styles` field is the set of surfaces the
  // user has opted in to — each subscriber checks for its own style before
  // reacting. (Single broadcast, multi-surface gating.) The engine fires
  // at most once per upward crossing of a given threshold (see AlertEngine).
  | {
      kind: 'alert';
      percent: number;
      severity: AlertSeverity;
      durationMs: number;
      styles: AlertStyle[];
    };

/**
 * Single source of truth for the current context-fill value. The poller writes
 * here; the sidebar view, the editor-area panel, and the status bar all
 * subscribe. Each surface stays unaware of the others.
 *
 * Late subscribers (e.g. a webview panel opened after the first poll) replay
 * the last known event via `replay()` so they're never blank.
 */
export class FillBroadcaster {
  private _last: FillEvent | undefined;
  private readonly _emitter = new vscode.EventEmitter<FillEvent>();
  public readonly onChange = this._emitter.event;

  postFill(value: number, meta: FillMeta): void {
    const ev: FillEvent = { kind: 'fill', value, meta };
    this._last = ev;
    this._emitter.fire(ev);
  }

  postState(text: string): void {
    const ev: FillEvent = { kind: 'state', text };
    this._last = ev;
    this._emitter.fire(ev);
  }

  /** Fan out an alert. NOT cached as `_last` — alerts are transient effects,
   *  not the steady-state value a late subscriber should replay. The `styles`
   *  list is the set of surfaces the user has opted in to; each subscriber
   *  checks for its own surface before reacting. */
  postAlert(
    percent: number,
    severity: AlertSeverity,
    durationMs: number,
    styles: AlertStyle[]
  ): void {
    this._emitter.fire({ kind: 'alert', percent, severity, durationMs, styles });
  }

  replay(handler: (e: FillEvent) => void): void {
    if (this._last) handler(this._last);
  }

  dispose(): void {
    this._emitter.dispose();
  }
}
