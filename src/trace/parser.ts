// Parse a raw Cline ui_messages.json array into a normalized TraceModel.
//
// Design constraints:
//  - Tolerate unknown event types — bucket them as kind:'unknown', never crash.
//  - Tolerate malformed inner JSON (api_req_started.text is itself a JSON string)
//    — try/catch around the inner parse, drop tokens silently on failure.
//  - Pure function: no I/O, no vscode imports. Reusable from tests.
//  - Phase segmentation is heuristic — see segmentPhases() for the rules.

import {
  AgentMode,
  AgentPhase,
  TraceEvent,
  TraceEventKind,
  TraceModel,
  TraceTotals
} from './types';

interface RawClineEvent {
  ts?: number;
  type?: 'say' | 'ask';
  say?: string;
  ask?: string;
  text?: string;
  partial?: boolean;
  conversationHistoryIndex?: number;
  conversationHistoryDeletedRange?: [number, number];
  images?: unknown;
}

interface ApiReqStartedPayload {
  request?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReads?: number;
  cacheWrites?: number;
  cost?: number;
  apiProtocol?: string;
}

interface ErrorRetryPayload {
  attempt?: number;
  maxAttempts?: number;
  delaySeconds?: number;
  errorMessage?: string;
}

// Map raw say/ask strings → normalized TraceEventKind. Keep this table as the
// SINGLE place that hard-codes Cline's vocabulary; everything downstream uses
// the normalized kind. Unknown strings fall through to 'unknown'.
const SAY_TO_KIND: Record<string, TraceEventKind> = {
  task: 'objective',
  api_req_started: 'llm_call',
  api_req_retried: 'llm_call',
  api_req_finished: 'llm_call', // older builds
  reasoning: 'reasoning',
  text: 'reasoning',
  tool: 'tool',
  command: 'command',
  browser_action: 'browser',
  browser_action_result: 'browser',
  error: 'error',
  error_retry: 'error',
  user_feedback: 'approval',
  completion_result: 'completion',
  deleted_api_reqs: 'truncation',
  checkpoint_created: 'checkpoint'
};

const ASK_KIND: TraceEventKind = 'approval';

function classifySay(say: string): TraceEventKind {
  return SAY_TO_KIND[say] ?? 'unknown';
}

/** Trim/normalize free-text fields for the timeline row label. */
function shortLabel(text: string | undefined, max = 140): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed;
}

function safeJsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * Try to derive a tool name + params from a raw `tool` say. Cline sometimes
 * embeds tool data as JSON in `text`, sometimes as a free-text description.
 * We try JSON first; if that fails we just keep the text as label.
 */
function parseToolText(text: string): { toolName?: string; params?: Record<string, unknown> } {
  const obj = safeJsonParse<Record<string, unknown>>(text);
  if (!obj || typeof obj !== 'object') return {};
  const toolName =
    typeof obj.tool === 'string'
      ? obj.tool
      : typeof obj.toolName === 'string'
        ? (obj.toolName as string)
        : undefined;
  const { tool: _t, toolName: _tn, ...rest } = obj;
  void _t;
  void _tn;
  return { toolName, params: rest };
}

/**
 * Normalize ONE raw event into a TraceEvent. Returns undefined if the event
 * is too malformed to use at all (very rare — usually we keep it as 'unknown').
 */
function normalizeOne(raw: RawClineEvent, idx: number): TraceEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ts = typeof raw.ts === 'number' ? raw.ts : 0;
  const id = `${ts}-${idx}`;

  let kind: TraceEventKind;
  if (raw.type === 'say' && raw.say) kind = classifySay(raw.say);
  else if (raw.type === 'ask') kind = ASK_KIND;
  else kind = 'unknown';

  const ev: TraceEvent = { id, rawIndex: idx, ts, kind, label: shortLabel(raw.text), raw };

  // Per-kind enrichment.
  switch (kind) {
    case 'llm_call': {
      const payload = safeJsonParse<ApiReqStartedPayload>(raw.text ?? '') ?? {};
      ev.tokensIn = numberOr(payload.tokensIn);
      ev.tokensOut = numberOr(payload.tokensOut);
      ev.cacheReads = numberOr(payload.cacheReads);
      ev.cacheWrites = numberOr(payload.cacheWrites);
      ev.cost = numberOr(payload.cost);
      if (raw.say === 'api_req_retried') ev.isRetry = true;
      // The request body is often huge and noisy; use a heuristic header for the label.
      if (payload.request) ev.label = shortLabel(payload.request, 120);
      else if (!ev.label) ev.label = raw.say ?? 'llm_call';
      break;
    }
    case 'error': {
      const payload = safeJsonParse<ErrorRetryPayload>(raw.text ?? '');
      if (payload?.errorMessage) {
        ev.errorMessage = shortLabel(payload.errorMessage, 200);
        ev.label = `retry ${payload.attempt ?? '?'}/${payload.maxAttempts ?? '?'} — ${ev.errorMessage}`;
      } else {
        ev.errorMessage = shortLabel(raw.text, 200);
      }
      break;
    }
    case 'tool': {
      const { toolName, params } = parseToolText(raw.text ?? '');
      ev.toolName = toolName;
      ev.params = params;
      if (toolName) ev.label = `${toolName}${params ? ' ' + shortLabel(JSON.stringify(params), 100) : ''}`;
      break;
    }
    case 'command': {
      // Cline stores the command itself in `text`.
      ev.label = shortLabel(raw.text, 200);
      break;
    }
    case 'truncation': {
      // Either say:'deleted_api_reqs' OR an event carrying conversationHistoryDeletedRange.
      const range = raw.conversationHistoryDeletedRange;
      if (range) ev.label = `truncated history range ${range[0]}…${range[1]}`;
      else ev.label = shortLabel(raw.text, 140) || 'context truncated';
      break;
    }
    case 'objective':
    case 'approval':
    case 'completion':
    case 'reasoning':
    case 'browser':
    case 'checkpoint':
    case 'unknown':
      // label already set from raw.text
      break;
  }

  // Always carry the raw 'say'/'ask' string in the label fallback so unknown
  // events are at least labelled with their original kind.
  if (!ev.label) ev.label = raw.say ?? raw.ask ?? raw.type ?? 'event';

  return ev;
}

function numberOr(v: unknown, fallback?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

/**
 * Segment a flat event list into AgentPhases.
 *
 * Heuristics (best-effort — Cline doesn't always tag the boundary explicitly):
 *   - The first event opens an 'act' phase.
 *   - A `say:'task'` repeated mid-stream (rare) opens a new top-level phase.
 *   - A tool invocation named 'new_task' opens a 'subtask' phase with
 *     parentId = the current phase id.
 *   - An ask of 'resume_task' / 'resume_completed_task' closes a subtask back
 *     to the parent.
 *   - An ask of 'plan_mode_respond' (if present) flips mode to 'plan'.
 *
 * Phase totals (tokens, toolCalls, errors) are accumulated as events land in
 * the phase. Cache tokens stay separate so the UI can render in/out/cache bars.
 */
function segmentPhases(events: TraceEvent[]): AgentPhase[] {
  if (events.length === 0) return [];

  const phases: AgentPhase[] = [];
  const stack: AgentPhase[] = [];
  let phaseSeq = 0;
  const openPhase = (mode: AgentMode, startTs: number, parentId?: string): AgentPhase => {
    const phase: AgentPhase = {
      id: `phase-${phaseSeq++}`,
      mode,
      parentId,
      startTs,
      events: [],
      tokensIn: 0,
      tokensOut: 0,
      cacheReads: 0,
      cacheWrites: 0,
      cost: 0,
      toolCalls: 0,
      errors: 0
    };
    phases.push(phase);
    stack.push(phase);
    return phase;
  };

  // Initial phase opens at the first event's timestamp.
  let current = openPhase('act', events[0].ts);

  for (const ev of events) {
    const raw = ev.raw as RawClineEvent;
    const isSubtaskStart = ev.kind === 'tool' && ev.toolName === 'new_task';
    const isResume = raw?.type === 'ask' && (raw.ask === 'resume_task' || raw.ask === 'resume_completed_task');
    const isPlanMode = raw?.type === 'ask' && raw.ask === 'plan_mode_respond';

    if (isResume && stack.length > 1) {
      // Close the top-of-stack subtask back to the parent.
      const closing = stack.pop()!;
      closing.endTs = ev.ts;
      current = stack[stack.length - 1];
    }

    if (isPlanMode && current.mode !== 'plan') {
      // Mode flip → new phase.
      current.endTs = ev.ts;
      stack.pop();
      current = openPhase('plan', ev.ts, current.parentId);
    }

    // Accumulate the event into the current phase BEFORE handling subtask-open,
    // so the new_task tool call is recorded against the parent phase.
    current.events.push(ev);
    if (ev.tokensIn) current.tokensIn += ev.tokensIn;
    if (ev.tokensOut) current.tokensOut += ev.tokensOut;
    if (ev.cacheReads) current.cacheReads += ev.cacheReads;
    if (ev.cacheWrites) current.cacheWrites += ev.cacheWrites;
    if (ev.cost) current.cost += ev.cost;
    if (ev.kind === 'tool') current.toolCalls += 1;
    if (ev.kind === 'error') current.errors += 1;

    if (isSubtaskStart) {
      current = openPhase('subtask', ev.ts, current.id);
    }
  }

  // Close any still-open phases at the last event's timestamp.
  const lastTs = events[events.length - 1].ts;
  for (const p of phases) if (p.endTs === undefined) p.endTs = lastTs;

  return phases;
}

function deriveObjective(events: TraceEvent[]): string {
  const first = events.find((e) => e.kind === 'objective');
  return first?.label ?? '';
}

function computeTotals(phases: AgentPhase[], events: TraceEvent[]): TraceTotals {
  const totals: TraceTotals = {
    tokensIn: 0,
    tokensOut: 0,
    cacheReads: 0,
    cacheWrites: 0,
    cost: 0,
    toolCalls: 0,
    errors: 0,
    llmCalls: 0
  };
  for (const p of phases) {
    totals.tokensIn += p.tokensIn;
    totals.tokensOut += p.tokensOut;
    totals.cacheReads += p.cacheReads;
    totals.cacheWrites += p.cacheWrites;
    totals.cost += p.cost;
    totals.toolCalls += p.toolCalls;
    totals.errors += p.errors;
  }
  totals.llmCalls = events.filter((e) => e.kind === 'llm_call').length;
  return totals;
}

export interface ParseInput {
  taskId: string;
  raw: unknown;
  sourceMtimeMs?: number;
}

/**
 * Top-level parser. Always returns a TraceModel — even when the input is
 * malformed, in which case the model is empty and the caller can decide
 * whether to keep the last good model instead.
 */
export function parseTrace({ taskId, raw, sourceMtimeMs }: ParseInput): TraceModel {
  const empty: TraceModel = {
    taskId,
    objective: '',
    phases: [],
    anomalies: [],
    totals: {
      tokensIn: 0,
      tokensOut: 0,
      cacheReads: 0,
      cacheWrites: 0,
      cost: 0,
      toolCalls: 0,
      errors: 0,
      llmCalls: 0
    },
    sourceMtimeMs
  };

  if (!Array.isArray(raw)) return empty;

  const events: TraceEvent[] = [];
  raw.forEach((r, i) => {
    const e = normalizeOne(r as RawClineEvent, i);
    if (e) events.push(e);
  });

  const phases = segmentPhases(events);
  const totals = computeTotals(phases, events);
  const objective = deriveObjective(events);

  return {
    taskId,
    objective,
    phases,
    anomalies: [], // Phase 9 fills this in
    totals,
    sourceMtimeMs
  };
}

/**
 * Exposed so anomaly detectors (Phase 9) can re-run on an existing model
 * without re-parsing.
 */
export function _internalExports(): {
  classifySay: typeof classifySay;
  segmentPhases: typeof segmentPhases;
} {
  return { classifySay, segmentPhases };
}
