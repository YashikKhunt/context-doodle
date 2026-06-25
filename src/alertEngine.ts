import * as vscode from 'vscode';
import { AlertSeverity, FillBroadcaster } from './fillBroadcaster';

/**
 * Threshold-crossing engine with hysteresis.
 *
 * Fires `onAlert(percent, severity)` exactly once per UPWARD crossing of each
 * configured threshold. A threshold re-arms only after the fill drops back
 * below `threshold - hysteresisMargin` — so a value oscillating around a
 * boundary (e.g. 70.1% / 69.9%) doesn't spam.
 *
 * Severity: thresholds at or above `criticalAt` are tagged `'critical'`,
 * the rest are `'warning'`. This is what subscribers use to pick colors,
 * shake intensity, etc.
 *
 * Initialization invariant: we DO NOT fire on the first sample after
 *   - the engine is constructed,
 *   - a `state` event is received (Cline disconnected → reconnected),
 *   - or any time we lose the producer.
 * Instead we treat the first observed fill as "ground truth" and arm only
 * those thresholds above it. That prevents an over-threshold session from
 * re-firing every alert at VS Code startup.
 */
export class AlertEngine implements vscode.Disposable {
  private _armed = new Set<number>();
  private _firstSample = true;
  private readonly _sub: vscode.Disposable;
  private readonly _emitter = new vscode.EventEmitter<{
    percent: number;
    severity: AlertSeverity;
  }>();
  public readonly onAlert = this._emitter.event;

  constructor(
    broadcaster: FillBroadcaster,
    private readonly _thresholds: number[],
    private readonly _hysteresisMargin: number,
    private readonly _criticalAt: number
  ) {
    this._sub = broadcaster.onChange((e) => {
      if (e.kind === 'state') {
        // Pause; the next fill event re-initializes the armed set.
        this._firstSample = true;
        return;
      }
      if (e.kind !== 'fill') return;
      this._handleFill(e.value);
    });
  }

  private _handleFill(fillRatio: number): void {
    const pct = fillRatio * 100;

    if (this._firstSample) {
      this._armed = new Set(this._thresholds.filter((t) => pct < t));
      this._firstSample = false;
      return;
    }

    let fired: number | undefined;
    for (const t of this._thresholds) {
      if (this._armed.has(t) && pct >= t) {
        this._armed.delete(t);
        fired = fired === undefined ? t : Math.max(fired, t);
      } else if (!this._armed.has(t) && pct < t - this._hysteresisMargin) {
        this._armed.add(t);
      }
    }
    if (fired !== undefined) {
      const severity: AlertSeverity = fired >= this._criticalAt ? 'critical' : 'warning';
      this._emitter.fire({ percent: fired, severity });
    }
  }

  dispose(): void {
    this._sub.dispose();
    this._emitter.dispose();
  }
}
