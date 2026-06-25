import * as vscode from 'vscode';
import { AlertSeverity, AlertStyle, FillBroadcaster } from './fillBroadcaster';

/**
 * Synthetic fill source for development: replaces the on-disk Cline poller so
 * the extension can be exercised without launching Cline or burning tokens.
 *
 * Owns three orthogonal mechanisms:
 *  - `setFill(percent)` — push a single value through the broadcaster.
 *  - `startSweep(periodMs)` — animate a 0→100→0 triangle wave on its own
 *    timer (60ms tick) so every color/threshold scrolls past in one go.
 *  - `fireAlert(percent, severity, styles, durationMs)` — bypass the
 *    AlertEngine and fan an alert straight to the surfaces, so each style
 *    can be inspected in isolation.
 *
 * Sweep and manual fill share the same broadcaster channel; calling
 * `setFill` while sweeping stops the sweep so the user's manual value sticks.
 */
export class DevFillSource implements vscode.Disposable {
  private _sweepTimer: NodeJS.Timeout | undefined;
  private _currentPercent = 0;

  constructor(
    private readonly _broadcaster: FillBroadcaster,
    private readonly _contextWindowMax: number
  ) {
    // Post an initial 0% so the surfaces show *something* immediately when
    // dev mode flips on — otherwise they'd sit at whatever the last real
    // poller value was, which is confusing.
    this._post(0);
  }

  /** Set the displayed fill to `percent` (0..100). Stops any running sweep. */
  setFill(percent: number): void {
    this.stopSweep();
    this._post(percent);
  }

  /** Bump the current value by `delta` percent (clamped). Stops sweep. */
  bump(delta: number): void {
    this.setFill(this._currentPercent + delta);
  }

  get currentPercent(): number {
    return this._currentPercent;
  }

  /**
   * Run a 0→100→0 triangle sweep with the given period (full cycle in ms).
   * Useful for visually checking every threshold/color/shape in one go.
   */
  startSweep(periodMs = 20000): void {
    this.stopSweep();
    const start = Date.now();
    this._sweepTimer = setInterval(() => {
      const t = ((Date.now() - start) % periodMs) / periodMs; // 0..1
      const tri = t < 0.5 ? t * 2 : (1 - t) * 2; // 0..1..0
      this._post(tri * 100);
    }, 60);
  }

  stopSweep(): void {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = undefined;
    }
  }

  isSweeping(): boolean {
    return this._sweepTimer !== undefined;
  }

  /**
   * Fan an alert directly to the surfaces, bypassing the AlertEngine. Lets
   * you exercise the shake/flash/badge/tag effects without having to walk
   * the fill across a threshold.
   */
  fireAlert(
    percent: number,
    severity: AlertSeverity,
    styles: AlertStyle[],
    durationMs: number
  ): void {
    this._broadcaster.postAlert(percent, severity, durationMs, styles);
  }

  private _post(percent: number): void {
    const clamped = Math.max(0, Math.min(100, percent));
    this._currentPercent = clamped;
    const ratio = clamped / 100;
    const used = Math.round(ratio * this._contextWindowMax);
    this._broadcaster.postFill(ratio, {
      contextUsed: used,
      contextWindowMax: this._contextWindowMax,
      fillRatio: ratio
    });
  }

  dispose(): void {
    this.stopSweep();
  }
}
