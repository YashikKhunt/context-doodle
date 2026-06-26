// Tier A anomaly detectors. Each is a pure function over the parsed TraceModel
// (or just the flat event list). They return Anomaly objects that the view
// renders as a "Flags" band + inline markers next to evidence rows.
//
// All thresholds are configurable so they can be tuned per-workflow without
// touching detector code.

import { Anomaly, TraceEvent, TraceModel } from './types';

export interface AnomalyConfig {
  /** Same (toolName, params) appearing this many times within a window of N
   *  consecutive tool events triggers a tool-loop flag. */
  toolLoopMinRepeats: number;
  toolLoopWindow: number;

  /** Error events within a window of N consecutive events triggers an
   *  error-storm flag. */
  errorStormMinErrors: number;
  errorStormWindow: number;

  /** Within a window of N consecutive llm_calls with no tool/command/completion
   *  events in between, if cumulative tokensIn exceeds this, flag as stall. */
  stallWindowLlmCalls: number;
  stallMinTokens: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  toolLoopMinRepeats: 3,
  toolLoopWindow: 5,
  errorStormMinErrors: 3,
  errorStormWindow: 5,
  stallWindowLlmCalls: 3,
  stallMinTokens: 50000
};

/** Canonicalize a tool's identity for loop detection: name + sorted JSON params. */
function toolFingerprint(ev: TraceEvent): string | undefined {
  if (ev.kind !== 'tool' || !ev.toolName) return undefined;
  if (!ev.params) return ev.toolName + '|{}';
  // Sort keys so {a:1,b:2} == {b:2,a:1}.
  try {
    const keys = Object.keys(ev.params).sort();
    const obj: Record<string, unknown> = {};
    for (const k of keys) obj[k] = ev.params[k];
    return ev.toolName + '|' + JSON.stringify(obj);
  } catch {
    return ev.toolName + '|<unserializable>';
  }
}

function detectToolLoops(events: TraceEvent[], cfg: AnomalyConfig): Anomaly[] {
  const tools = events.filter((e) => e.kind === 'tool');
  if (tools.length < cfg.toolLoopMinRepeats) return [];

  const anomalies: Anomaly[] = [];
  const flagged = new Set<string>(); // dedupe by fingerprint per slide

  for (let i = 0; i + cfg.toolLoopWindow <= tools.length || i === 0; i++) {
    const window = tools.slice(i, i + cfg.toolLoopWindow);
    if (window.length < cfg.toolLoopMinRepeats) break;
    const counts = new Map<string, TraceEvent[]>();
    for (const ev of window) {
      const fp = toolFingerprint(ev);
      if (!fp) continue;
      const arr = counts.get(fp) ?? [];
      arr.push(ev);
      counts.set(fp, arr);
    }
    for (const [fp, evs] of counts.entries()) {
      if (evs.length < cfg.toolLoopMinRepeats) continue;
      // Dedupe so a slide that keeps the same fingerprint doesn't emit twice.
      const dedupeKey = fp + ':' + evs[0].id;
      if (flagged.has(dedupeKey)) continue;
      flagged.add(dedupeKey);
      const toolName = evs[0].toolName ?? 'tool';
      anomalies.push({
        type: 'tool-loop',
        severity: evs.length >= cfg.toolLoopMinRepeats + 1 ? 'critical' : 'warning',
        atTs: evs[evs.length - 1].ts,
        evidence: evs.map((e) => e.id),
        message: `Tool '${toolName}' called ${evs.length} times with near-identical params in a window of ${cfg.toolLoopWindow} tool calls.`
      });
    }
  }
  return anomalies;
}

function detectErrorStorms(events: TraceEvent[], cfg: AnomalyConfig): Anomaly[] {
  if (events.length < cfg.errorStormMinErrors) return [];
  const anomalies: Anomaly[] = [];
  const emitted = new Set<string>(); // dedupe by first-event-id

  for (let i = 0; i <= events.length - cfg.errorStormWindow; i++) {
    const window = events.slice(i, i + cfg.errorStormWindow);
    const errs = window.filter((e) => e.kind === 'error');
    if (errs.length < cfg.errorStormMinErrors) continue;
    const firstId = errs[0].id;
    if (emitted.has(firstId)) continue;
    emitted.add(firstId);
    anomalies.push({
      type: 'error-storm',
      severity: 'critical',
      atTs: errs[errs.length - 1].ts,
      evidence: errs.map((e) => e.id),
      message: `${errs.length} error/retry events within a window of ${cfg.errorStormWindow} events.`
    });
  }
  return anomalies;
}

function detectStalls(events: TraceEvent[], cfg: AnomalyConfig): Anomaly[] {
  // Walk through llm_call events; if N+ of them are consecutive (no tool/
  // command/completion event in between) AND the cumulative tokensIn over
  // the window exceeds the threshold, flag as stall.
  const anomalies: Anomaly[] = [];
  let consecutiveLlm: TraceEvent[] = [];
  let cumulativeTokens = 0;
  let emittedFor: Set<string> = new Set();

  const flushIfStall = (): void => {
    if (consecutiveLlm.length < cfg.stallWindowLlmCalls) return;
    if (cumulativeTokens < cfg.stallMinTokens) return;
    const firstId = consecutiveLlm[0].id;
    if (emittedFor.has(firstId)) return;
    emittedFor.add(firstId);
    anomalies.push({
      type: 'stall',
      severity: 'warning',
      atTs: consecutiveLlm[consecutiveLlm.length - 1].ts,
      evidence: consecutiveLlm.map((e) => e.id),
      message:
        `${consecutiveLlm.length} consecutive LLM calls totalling ~${Math.round(cumulativeTokens / 1000)}k input tokens with no tool/command/completion in between.`
    });
  };

  for (const ev of events) {
    if (ev.kind === 'llm_call') {
      consecutiveLlm.push(ev);
      cumulativeTokens += (ev.tokensIn ?? 0) + (ev.cacheReads ?? 0);
    } else if (ev.kind === 'tool' || ev.kind === 'command' || ev.kind === 'completion') {
      flushIfStall();
      consecutiveLlm = [];
      cumulativeTokens = 0;
    }
    // reasoning / approval / browser / etc. don't break a stall — the agent
    // is still in its head, hasn't done anything in the world.
  }
  flushIfStall();
  return anomalies;
}

function detectContextLoss(events: TraceEvent[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  // Two flavours: explicit truncation events, and step changes in
  // conversationHistoryDeletedRange between consecutive events.
  for (const ev of events) {
    if (ev.kind === 'truncation') {
      anomalies.push({
        type: 'context-loss',
        severity: 'warning',
        atTs: ev.ts,
        evidence: [ev.id],
        message: ev.label || 'Conversation history was truncated.'
      });
    }
  }

  let prevRange: [number, number] | undefined;
  for (const ev of events) {
    const r = (ev.raw as { conversationHistoryDeletedRange?: [number, number] })
      ?.conversationHistoryDeletedRange;
    if (!r) continue;
    if (!prevRange || r[0] !== prevRange[0] || r[1] !== prevRange[1]) {
      // Skip the very first observation — that's the steady state, not a loss.
      if (prevRange) {
        anomalies.push({
          type: 'context-loss',
          severity: 'warning',
          atTs: ev.ts,
          evidence: [ev.id],
          message: `Deletion range moved to ${r[0]}…${r[1]} (was ${prevRange[0]}…${prevRange[1]}).`
        });
      }
      prevRange = r;
    }
  }
  return anomalies;
}

export function detectAnomalies(
  model: TraceModel,
  cfg: AnomalyConfig = DEFAULT_ANOMALY_CONFIG
): Anomaly[] {
  const events = model.phases.flatMap((p) => p.events);
  return [
    ...detectToolLoops(events, cfg),
    ...detectErrorStorms(events, cfg),
    ...detectStalls(events, cfg),
    ...detectContextLoss(events)
  ];
}
