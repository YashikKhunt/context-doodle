// Normalized, provider-agnostic trace model. The parser maps raw Cline/Roo/Kilo
// ui_messages.json events into these shapes; the view and the anomaly detectors
// only see this normalized model. That decoupling is what lets the same UI work
// across all three agents — only the parser knows about the raw schema.

export type TraceEventKind =
  | 'llm_call'      // an API request to the model (api_req_started, api_req_retried)
  | 'reasoning'     // model thinking or plain text output
  | 'tool'          // tool invocation
  | 'command'       // terminal command invocation
  | 'browser'       // browser_action or browser_action_result
  | 'error'         // any error/retry signal
  | 'approval'      // human-in-the-loop pause (ask events, user_feedback)
  | 'truncation'    // context truncation / deleted_api_reqs
  | 'completion'    // task or subtask completion
  | 'objective'     // the initial user task (one per TraceModel)
  | 'checkpoint'    // internal bookkeeping (kept but easy to filter in UI)
  | 'unknown';      // anything the parser doesn't recognize — bucketed, never crashed on

export interface TraceEvent {
  id: string;              // synthetic stable id (`${ts}-${idx}`) for keyed rendering
  rawIndex: number;        // position in the source array, useful for debugging
  ts: number;
  kind: TraceEventKind;
  label: string;           // short human-readable line ("explain me this code @/load_dataset.py")
  tokensIn?: number;
  tokensOut?: number;
  cacheReads?: number;
  cacheWrites?: number;
  cost?: number;
  toolName?: string;
  params?: Record<string, unknown>;
  isRetry?: boolean;
  errorMessage?: string;
  // Original raw event kept verbatim so the view can offer a "show raw" affordance
  // and so anomaly detectors can reach back for fields the normalizer dropped.
  raw: unknown;
}

export type AgentMode = 'plan' | 'act' | 'subtask';

export interface AgentPhase {
  id: string;
  mode: AgentMode;
  parentId?: string;
  startTs: number;
  endTs?: number;
  events: TraceEvent[];
  tokensIn: number;
  tokensOut: number;
  cacheReads: number;
  cacheWrites: number;
  cost: number;
  toolCalls: number;
  errors: number;
}

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface Anomaly {
  type: 'tool-loop' | 'error-storm' | 'stall' | 'context-loss' | 'plan-drift';
  severity: AnomalySeverity;
  atTs: number;
  // Pointers back to the events that produced this finding. Lets the UI link
  // the anomaly badge to the rows that triggered it.
  evidence: string[]; // TraceEvent.id values
  message: string;
}

export interface TraceTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReads: number;
  cacheWrites: number;
  cost: number;
  toolCalls: number;
  errors: number;
  llmCalls: number;
}

export interface DriftResult {
  score: number;       // 0..1, where 1 = fully on-topic vs. the objective
  reason: string;
  strategy: 'embeddings' | 'lm';
  basis?: string;      // short description of what was actually compared
}

export interface TraceModel {
  taskId: string;
  objective: string;       // first user-provided task description, empty if absent
  phases: AgentPhase[];
  anomalies: Anomaly[];
  totals: TraceTotals;
  // Source mtime so consumers can debounce on "model changed" rather than
  // re-running deep equality.
  sourceMtimeMs?: number;
  // Tier B: present only when contextDoodle.agentTrace.driftStrategy is on
  // AND a checker has produced a result. Absent in pure Tier-A mode.
  drift?: DriftResult;
}
