import * as vscode from 'vscode';
import { FillBroadcaster, FillEvent } from './fillBroadcaster';

/**
 * Status-bar surface. Always-visible (no clicking needed) ambient indicator.
 *
 * The "blob" here is a single character that grows visually with fill:
 *     ·   ∘   ○   ◌   ◎   ●   ⬤
 * and pulses between adjacent characters on a slow timer so it feels alive.
 *
 * Above 60%/85% fill we flip the item's backgroundColor to VS Code's
 * built-in warning/error theme colors. That makes the status bar segment
 * physically light up amber/red — strongest possible ambient signal short of
 * a popup.
 *
 * Tweens toward the target fill at ~18%/frame so updates from the poller
 * (every ~2s) feel smooth, not steppy.
 */
export class StatusBarBlob implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _sub: vscode.Disposable;
  private readonly _tweenTimer: NodeJS.Timeout;
  private readonly _pulseTimer: NodeJS.Timeout;
  private _currentFill = 0;
  private _targetFill = 0;
  private _phase = 0;
  private _used = 0;
  private _max = 200000;
  private _mode: 'fill' | 'state' | 'missing' = 'fill';
  private _stateText = '';
  // Flash effect: a separate, faster pulse that toggles the background between
  // the alert color and undefined for `flashDurationMs`. Driven by its own
  // timer so it doesn't depend on the steady tween/pulse cadence.
  private _flashTimer: NodeJS.Timeout | undefined;
  private _flashDeadline = 0;
  private _flashSeverity: 'warning' | 'critical' | undefined;
  private _flashPhase = 0;

  private static readonly CHARS = ['·', '∘', '○', '◌', '◎', '●', '⬤'];

  constructor(broadcaster: FillBroadcaster) {
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this._item.name = 'Context Doodle';
    this._item.command = 'contextDoodle.revealSidebar';
    this._item.show();

    this._sub = broadcaster.onChange((e) => this._onEvent(e));
    broadcaster.replay((e) => this._onEvent(e));

    // Smooth ease toward the target — runs even when the value is stable so
    // the pulse phase stays in sync.
    this._tweenTimer = setInterval(() => this._tween(), 60);
    // Slow pulse: alternate phase every ~700ms so the blob char "breathes".
    this._pulseTimer = setInterval(() => {
      this._phase = (this._phase + 1) % 2;
      this._render();
    }, 700);

    this._render();
  }

  private _onEvent(e: FillEvent): void {
    if (e.kind === 'state') {
      this._mode = 'state';
      this._stateText = e.text;
    } else if (e.kind === 'fill') {
      this._mode = 'fill';
      this._targetFill = Math.max(0, Math.min(1, e.value));
      this._used = e.meta.contextUsed;
      this._max = e.meta.contextWindowMax;
    } else if (e.kind === 'alert') {
      if (e.styles.includes('statusBarFlash')) {
        this._startFlash(e.severity, e.durationMs);
      }
    }
    this._render();
  }

  private _startFlash(severity: 'warning' | 'critical', durationMs: number): void {
    this._flashSeverity = severity;
    this._flashDeadline = Date.now() + durationMs;
    this._flashPhase = 0;
    if (this._flashTimer) return;
    // 150ms strobe — fast enough to register as "attention!", slow enough
    // not to feel like a seizure.
    this._flashTimer = setInterval(() => {
      this._flashPhase = (this._flashPhase + 1) % 2;
      if (Date.now() >= this._flashDeadline) {
        clearInterval(this._flashTimer!);
        this._flashTimer = undefined;
        this._flashSeverity = undefined;
      }
      this._render();
    }, 150);
  }

  private _tween(): void {
    const next = this._currentFill + (this._targetFill - this._currentFill) * 0.18;
    if (Math.abs(next - this._currentFill) < 0.0005) {
      if (this._currentFill === this._targetFill) return;
      this._currentFill = this._targetFill;
    } else {
      this._currentFill = next;
    }
    this._render();
  }

  private _render(): void {
    if (this._mode === 'state') {
      this._item.text = '$(circle-slash) ctx';
      this._item.tooltip = this._stateText;
      this._item.backgroundColor = undefined;
      this._item.color = undefined;
      return;
    }

    const f = this._currentFill;
    const baseIdx = Math.min(StatusBarBlob.CHARS.length - 1, Math.floor(f * (StatusBarBlob.CHARS.length - 1)));
    // Pulse one step up/down around the base index so the blob breathes.
    const pulsedIdx = Math.min(StatusBarBlob.CHARS.length - 1, baseIdx + this._phase);
    const char = StatusBarBlob.CHARS[pulsedIdx];
    const pct = Math.round(f * 100);

    this._item.text = `${char} ${pct}% ctx`;
    this._item.tooltip = `${this._used.toLocaleString()} / ${this._max.toLocaleString()} tokens (${pct}%) — click to reveal Context Doodle`;

    // Flash takes precedence: alternate background between alert color and
    // the steady-state color so the eye catches the motion.
    if (this._flashSeverity) {
      const flashColor =
        this._flashSeverity === 'critical'
          ? 'statusBarItem.errorBackground'
          : 'statusBarItem.warningBackground';
      this._item.backgroundColor =
        this._flashPhase === 0 ? new vscode.ThemeColor(flashColor) : undefined;
      return;
    }

    if (f >= 0.85) {
      this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (f >= 0.6) {
      this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this._item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    clearInterval(this._tweenTimer);
    clearInterval(this._pulseTimer);
    if (this._flashTimer) clearInterval(this._flashTimer);
    this._sub.dispose();
    this._item.dispose();
  }
}
