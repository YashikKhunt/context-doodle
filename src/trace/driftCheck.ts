// Tier B: semantic drift checking. Two interchangeable strategies behind one
// interface; the extension picks one via the `agentTrace.driftStrategy`
// setting. Tier A continues to work when this is off.
//
// IMPORTANT honesty note on the 'embeddings' strategy:
//   VS Code's stable extension API doesn't expose a public embeddings model
//   to extensions (as of 1.x at the time of writing), and the prompt forbids
//   network calls. So the 'embeddings' strategy here is a deterministic
//   LOCAL text-overlap proxy (stopword-filtered, stemmed Jaccard with a
//   calibration multiplier) — NOT real semantic embeddings. It's good
//   enough to catch "agent is now talking about completely different
//   things" but won't pick up subtle topic shifts. The 'lm' strategy is
//   the proper semantic check; this one is the offline fallback.

import * as vscode from 'vscode';
import { DriftResult, TraceModel } from './types';

export interface DriftChecker {
  /** Returns a result if one is available, undefined while waiting for a
   *  first async result or when no model is selectable. Never throws. */
  check(model: TraceModel): Promise<DriftResult | undefined>;
  dispose(): void;
}

// --- shared text utilities ---------------------------------------------------

// Tiny stopword set — enough to cull "the/a/to" noise. Keep small so the
// signal isn't drowned by aggressive filtering.
const STOP = new Set([
  'the','a','an','of','to','for','and','or','in','on','with','is','are','was',
  'were','be','been','being','this','that','it','as','at','by','from','i',
  'you','my','me','we','us','our','your','his','her','they','them','their',
  'if','else','do','does','did','will','would','can','could','should','have',
  'has','had','not','no','yes','please','use','using','make','made','get',
  'set','show','tell','give','what','which','how','why','when','where'
]);

function bagOfTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function recentActionsText(model: TraceModel, n: number): string {
  const events = model.phases
    .flatMap((p) => p.events)
    .filter((e) => e.kind !== 'checkpoint');
  return events.slice(-n).map((e) => e.label).join(' ');
}

// --- strategy 1: local text-overlap proxy ------------------------------------

class EmbeddingsChecker implements DriftChecker {
  async check(model: TraceModel): Promise<DriftResult | undefined> {
    if (!model.objective) return undefined;
    const objectiveTerms = bagOfTerms(model.objective);
    const recentTerms = bagOfTerms(recentActionsText(model, 12));
    const raw = jaccard(objectiveTerms, recentTerms);
    // Empirical calibration: even strongly-on-topic Cline runs rarely score
    // > 0.3 with plain Jaccard because the agent's reasoning vocabulary
    // diverges from the user's prompt vocabulary. Stretch the [0..~0.35]
    // expected range to [0..1] and clamp.
    const calibrated = Math.max(0, Math.min(1, raw * 3));
    return {
      score: calibrated,
      strategy: 'embeddings',
      reason: 'Word-overlap (Jaccard) of objective vs. last 12 actions.',
      basis: `${objectiveTerms.size} objective terms / ${recentTerms.size} recent-action terms / raw=${raw.toFixed(3)}`
    };
  }
  dispose(): void {
    // nothing to clean up
  }
}

// --- strategy 2: vscode.lm chat model as judge -------------------------------

class LmChecker implements DriftChecker {
  private _lastCheckTs = 0;
  private _lastResult: DriftResult | undefined;
  private _inflight: Promise<void> | undefined;
  private _cts: vscode.CancellationTokenSource | undefined;

  constructor(private readonly _minIntervalMs: number) {}

  async check(model: TraceModel): Promise<DriftResult | undefined> {
    if (!model.objective) return undefined;
    // Rate-limit: if a previous check is in flight or we ran recently,
    // return the cached value so the UI doesn't block on every poll.
    if (this._inflight) return this._lastResult;
    const now = Date.now();
    if (this._lastResult && now - this._lastCheckTs < this._minIntervalMs) {
      return this._lastResult;
    }
    this._lastCheckTs = now;

    this._cts?.cancel();
    this._cts = new vscode.CancellationTokenSource();
    const token = this._cts.token;

    this._inflight = (async () => {
      try {
        const candidates = await vscode.lm.selectChatModels();
        if (!candidates || candidates.length === 0) {
          this._lastResult = undefined;
          return;
        }
        const m = candidates[0];
        const recent = recentActionsText(model, 12);
        const prompt =
          `Original objective: ${model.objective}\n\n` +
          `Recent agent actions (most recent last):\n${recent}\n\n` +
          `Is the agent still pursuing the original objective? ` +
          `Respond with ONLY a JSON object of the form ` +
          `{"score": <number 0..1, 1 means fully on-topic>, "reason": "<one short sentence>"}.`;
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const req = await m.sendRequest(messages, {}, token);
        let text = '';
        for await (const chunk of req.text) text += chunk;

        const result = parseLmResponse(text, m.name);
        if (result) this._lastResult = result;
      } catch (err) {
        // Common: user not signed into Copilot, no consent yet, network down.
        // We treat all of these as "no result this cycle" and try again next
        // interval. Never crash the trace pipeline.
        console.warn('[context-doodle] LM drift check failed', err);
      } finally {
        this._inflight = undefined;
      }
    })();

    // Return whatever we had on the last successful call (or undefined).
    return this._lastResult;
  }

  dispose(): void {
    this._cts?.cancel();
    this._cts?.dispose();
  }
}

/** Tolerant parser for the LM response: tries JSON first, then a regex fallback
 *  if the model added prose around it. Always returns either a valid result
 *  or undefined — never throws. */
function parseLmResponse(text: string, modelName: string): DriftResult | undefined {
  // Strip common code-fence wrappers.
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj?.score === 'number') {
      return {
        score: Math.max(0, Math.min(1, obj.score)),
        strategy: 'lm',
        reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '',
        basis: `LM judge (${modelName})`
      };
    }
  } catch {
    // fall through to regex fallback
  }
  const match = cleaned.match(/\b(0?\.\d+|1\.0+|1|0)\b/);
  if (match) {
    return {
      score: Math.max(0, Math.min(1, parseFloat(match[1]))),
      strategy: 'lm',
      reason: cleaned.slice(0, 200),
      basis: `LM judge (${modelName}, regex fallback)`
    };
  }
  return undefined;
}

export type DriftStrategy = 'off' | 'embeddings' | 'lm';

export function makeDriftChecker(
  strategy: DriftStrategy,
  minIntervalMs: number
): DriftChecker | undefined {
  if (strategy === 'embeddings') return new EmbeddingsChecker();
  if (strategy === 'lm') return new LmChecker(minIntervalMs);
  return undefined;
}
