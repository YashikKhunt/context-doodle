import * as vscode from 'vscode';
import { TraceModel } from './types';

export type TraceEvent =
  | { kind: 'trace'; model: TraceModel }
  | { kind: 'state'; text: string };

/**
 * Mirror of FillBroadcaster for the parsed TraceModel. Kept separate because
 * the two channels have different update cadences and very different payload
 * sizes — fanning them through one bus would force every fill update to drag
 * a model copy along, or vice versa.
 *
 * Late subscribers (a view opened after the first parse) replay the last
 * known event via `replay()`.
 */
export class TraceBroadcaster {
  private _last: TraceEvent | undefined;
  private readonly _emitter = new vscode.EventEmitter<TraceEvent>();
  public readonly onChange = this._emitter.event;

  postTrace(model: TraceModel): void {
    const ev: TraceEvent = { kind: 'trace', model };
    this._last = ev;
    this._emitter.fire(ev);
  }

  postState(text: string): void {
    const ev: TraceEvent = { kind: 'state', text };
    this._last = ev;
    this._emitter.fire(ev);
  }

  replay(handler: (e: TraceEvent) => void): void {
    if (this._last) handler(this._last);
  }

  /** Convenience for debouncing: only re-publish if the source file actually changed. */
  shouldRepublish(model: TraceModel): boolean {
    if (!this._last || this._last.kind !== 'trace') return true;
    const prev = this._last.model;
    return (
      prev.taskId !== model.taskId ||
      prev.sourceMtimeMs !== model.sourceMtimeMs ||
      prev.totals.llmCalls !== model.totals.llmCalls
    );
  }

  dispose(): void {
    this._emitter.dispose();
  }
}
