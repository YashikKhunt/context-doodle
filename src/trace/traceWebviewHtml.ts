// Inline HTML for the Agent Trace view. Same security posture as the doodle:
// default-src 'none' CSP, per-load nonce on the one inline script.
//
// The view receives one message kind in this phase:
//   { type: 'trace', model: TraceModel }
//   { type: 'state', text: string }
// Future phases extend the contract (anomalies overlay, drift indicator, etc.)
// — the message handler is structured to forward-tolerate unknown fields.

import * as vscode from 'vscode';

export function buildTraceHtml(webview: vscode.Webview, nonce: string): string {
  const cspSource = webview.cspSource;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <title>Agent Trace</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
    }
    #root { padding: 6px 8px 16px; }
    #empty { padding: 24px 12px; color: var(--vscode-descriptionForeground); font-style: italic; line-height: 1.5; }
    .header {
      position: sticky; top: 0;
      background: var(--vscode-sideBar-background, transparent);
      padding: 8px 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      z-index: 1;
    }
    .header .objective { font-weight: 600; word-break: break-word; }
    .header .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
      gap: 4px 10px;
      margin-top: 6px;
      font-size: 11px;
    }
    .header .stat { display: flex; flex-direction: column; line-height: 1.15; }
    .header .stat .k { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
    .header .stat .v { font-variant-numeric: tabular-nums; }
    .header .stat .v.err { color: var(--vscode-charts-red, #f48771); }
    .header .stat .v.drift-low  { color: var(--vscode-charts-red, #f48771); }
    .header .stat .v.drift-mid  { color: var(--vscode-charts-yellow, #e2c08d); }
    .header .stat .v.drift-high { color: var(--vscode-charts-green, #89d185); }
    /* Stacked horizontal token bar — in (blue) + cache (green) + out (orange).
       Width of the row is proportional to the phase's share of total tokens. */
    .phase-bar-wrap { margin: 4px 0 2px 24px; }
    .phase-bar {
      display: flex; height: 4px; border-radius: 2px;
      background: var(--vscode-panel-border, rgba(128,128,128,0.15));
      overflow: hidden;
    }
    .phase-bar > span { display: block; height: 100%; }
    .phase-bar .seg-in    { background: var(--vscode-charts-blue, #4ea1ff); }
    .phase-bar .seg-cache { background: var(--vscode-charts-green, #89d185); opacity: 0.85; }
    .phase-bar .seg-out   { background: var(--vscode-charts-orange, #d18616); }
    .phase-bar-legend {
      display: flex; gap: 8px; font-size: 10px; margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    /* Flags band sits between header and phases when anomalies exist. */
    .flags { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
    .flag {
      display: grid;
      grid-template-columns: 18px auto 1fr;
      gap: 6px;
      align-items: baseline;
      padding: 5px 8px;
      border-left: 3px solid var(--vscode-charts-yellow, #e2c08d);
      background: var(--vscode-inputValidation-warningBackground, rgba(226, 192, 141, 0.08));
      border-radius: 2px;
      font-size: 12px;
    }
    .flag.critical {
      border-left-color: var(--vscode-charts-red, #f48771);
      background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.08));
    }
    .flag .ic { font-size: 12px; text-align: center; line-height: 1; }
    .flag .type {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground); padding-right: 4px;
    }
    .flag .msg { word-break: break-word; }
    /* Event rows that participated in any anomaly get a subtle left border. */
    .event.has-anomaly { border-left: 2px solid var(--vscode-charts-yellow, #e2c08d); padding-left: 4px; margin-left: -6px; }
    .event.has-anomaly.critical-anomaly { border-left-color: var(--vscode-charts-red, #f48771); }
    .phase { margin-top: 14px; }
    .phase-head {
      display: flex; align-items: center; gap: 6px;
      cursor: pointer; user-select: none;
      padding: 4px 2px; border-radius: 3px;
    }
    .phase-head:hover { background: var(--vscode-list-hoverBackground, transparent); }
    .phase-head .chev { width: 10px; display: inline-block; transition: transform 120ms ease; }
    .phase-head.collapsed .chev { transform: rotate(-90deg); }
    .phase-head .mode {
      font-size: 10px; text-transform: uppercase;
      padding: 1px 5px; border-radius: 3px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.3));
      color: var(--vscode-badge-foreground, inherit);
      letter-spacing: 0.5px;
    }
    .phase-head .mode.subtask { background: var(--vscode-charts-purple, #b180d7); color: white; }
    .phase-head .mode.plan { background: var(--vscode-charts-yellow, #e2c08d); color: black; }
    .phase-head .totals { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .events { margin: 4px 0 0 18px; border-left: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.25)); padding-left: 8px; }
    .events.collapsed { display: none; }
    .event {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 6px;
      padding: 3px 0;
      align-items: baseline;
    }
    .event .icon { font-size: 12px; line-height: 1; text-align: center; opacity: 0.9; }
    .event .label { word-break: break-word; }
    .event .delta { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .event.error .icon { color: var(--vscode-charts-red, #f48771); }
    .event.error .label { color: var(--vscode-charts-red, #f48771); }
    .event.truncation .icon { color: var(--vscode-charts-orange, #d18616); }
    .event.completion .icon { color: var(--vscode-charts-green, #89d185); }
    .event.objective .icon { color: var(--vscode-charts-blue, #4ea1ff); }
    .event.checkpoint { opacity: 0.45; }
    .event.unknown { opacity: 0.7; }
  </style>
</head>
<body>
  <div id="root">
    <div id="empty">Waiting for an active task…</div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const root = document.getElementById('root');

      // Pure data → DOM transforms. No frameworks; just template strings and
      // event delegation on the root for collapse toggles.
      const ICONS = {
        objective: '◉', llm_call: '↻', reasoning: '✎',
        tool: '⚒', command: '$', browser: '◫',
        error: '⚠', approval: '◔', truncation: '⊟',
        completion: '✓', checkpoint: '•', unknown: '?'
      };

      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
      function fmtCost(n) {
        if (!n) return '$0';
        if (n < 0.01) return '<$0.01';
        return '$' + n.toFixed(n < 1 ? 3 : 2);
      }

      // Stacked bar: in/cache/out widths proportional to the phase's tokens,
      // and the whole bar's max-width is proportional to the phase's share of
      // total tokens (so a phase that used 5% of all tokens is visually small).
      function phaseBar(phase, grandTotal) {
        const phaseTotal = phase.tokensIn + phase.cacheReads + phase.tokensOut;
        if (phaseTotal === 0) return '';
        const widthPct = grandTotal > 0 ? Math.max(2, (phaseTotal / grandTotal) * 100) : 100;
        const inPct    = (phase.tokensIn   / phaseTotal) * 100;
        const cachePct = (phase.cacheReads / phaseTotal) * 100;
        const outPct   = (phase.tokensOut  / phaseTotal) * 100;
        return (
          '<div class="phase-bar-wrap" style="width:' + widthPct.toFixed(1) + '%; min-width: 60px;">' +
            '<div class="phase-bar">' +
              (inPct    > 0 ? '<span class="seg-in"    style="width:' + inPct.toFixed(1) + '%"></span>' : '') +
              (cachePct > 0 ? '<span class="seg-cache" style="width:' + cachePct.toFixed(1) + '%"></span>' : '') +
              (outPct   > 0 ? '<span class="seg-out"   style="width:' + outPct.toFixed(1) + '%"></span>' : '') +
            '</div>' +
            '<div class="phase-bar-legend">' +
              (phase.tokensIn   ? '<span>in '    + fmtTokens(phase.tokensIn)   + '</span>' : '') +
              (phase.cacheReads ? '<span>cache ' + fmtTokens(phase.cacheReads) + '</span>' : '') +
              (phase.tokensOut  ? '<span>out '   + fmtTokens(phase.tokensOut)  + '</span>' : '') +
            '</div>' +
          '</div>'
        );
      }

      // Set of event ids that participated in any anomaly; populated by render().
      let anomalyIds = new Set();
      let criticalAnomalyIds = new Set();

      function eventRow(ev) {
        const icon = ICONS[ev.kind] || '·';
        let delta = '';
        if (ev.kind === 'llm_call' && (ev.tokensIn || ev.tokensOut || ev.cacheReads)) {
          const parts = [];
          if (ev.tokensIn)   parts.push('in ' + fmtTokens(ev.tokensIn));
          if (ev.cacheReads) parts.push('cache ' + fmtTokens(ev.cacheReads));
          if (ev.tokensOut)  parts.push('out ' + fmtTokens(ev.tokensOut));
          delta = parts.join(' · ');
        }
        const extraCls =
          (anomalyIds.has(ev.id) ? ' has-anomaly' : '') +
          (criticalAnomalyIds.has(ev.id) ? ' critical-anomaly' : '');
        return (
          '<div class="event ' + ev.kind + extraCls + '">' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="label">' + esc(ev.label || ev.kind) + '</span>' +
            '<span class="delta">' + esc(delta) + '</span>' +
          '</div>'
        );
      }

      function phaseBlock(phase, idx, grandTotalTokens) {
        const totalsBits = [];
        if (phase.toolCalls) totalsBits.push(phase.toolCalls + ' tool');
        if (phase.errors)    totalsBits.push(phase.errors + ' err');
        if (phase.cost)      totalsBits.push(fmtCost(phase.cost));
        const totals = totalsBits.join(' · ');
        const modeClass = 'mode ' + esc(phase.mode);
        return (
          '<div class="phase" data-phase="' + idx + '">' +
            '<div class="phase-head" data-toggle="' + idx + '">' +
              '<span class="chev">▾</span>' +
              '<span class="' + modeClass + '">' + esc(phase.mode) + '</span>' +
              '<span class="totals">' + totals + '</span>' +
            '</div>' +
            phaseBar(phase, grandTotalTokens) +
            '<div class="events" data-events="' + idx + '">' +
              phase.events.map(eventRow).join('') +
            '</div>' +
          '</div>'
        );
      }

      function flagBlock(a) {
        const icons = { 'tool-loop': '↻', 'error-storm': '⚠', stall: '⏸', 'context-loss': '⊟', 'plan-drift': '↯' };
        const ic = icons[a.type] || '⚠';
        return (
          '<div class="flag ' + esc(a.severity) + '">' +
            '<span class="ic">' + ic + '</span>' +
            '<span class="type">' + esc(a.type) + '</span>' +
            '<span class="msg">' + esc(a.message) + '</span>' +
          '</div>'
        );
      }

      function render(model) {
        if (!model || !model.phases || model.phases.length === 0) {
          root.innerHTML = '<div id="empty">No events yet for this task.</div>';
          return;
        }
        const objective = model.objective || '(no objective)';
        const t = model.totals;
        const subtasks = model.phases.filter(p => p.mode === 'subtask').length;
        const grandTotalTokens = t.tokensIn + t.cacheReads + t.tokensOut;

        // Rebuild the evidence-id sets so eventRow can mark them.
        anomalyIds = new Set();
        criticalAnomalyIds = new Set();
        const anomalies = model.anomalies || [];
        for (const a of anomalies) {
          for (const id of (a.evidence || [])) {
            anomalyIds.add(id);
            if (a.severity === 'critical') criticalAnomalyIds.add(id);
          }
        }
        const flagsHtml = anomalies.length
          ? '<div class="flags">' + anomalies.map(flagBlock).join('') + '</div>'
          : '';

        // Per-cell summary stats. Errors get a red v-color when nonzero.
        const stats = [
          { k: 'Phases',    v: String(model.phases.length) + (subtasks ? ' (' + subtasks + ' sub)' : '') },
          { k: 'LLM calls', v: String(t.llmCalls) },
          { k: 'Tokens in', v: fmtTokens(t.tokensIn + t.cacheReads) },
          { k: 'Tokens out',v: fmtTokens(t.tokensOut) },
          { k: 'Tools',     v: String(t.toolCalls) },
          { k: 'Errors',    v: String(t.errors), cls: t.errors ? 'err' : '' },
          { k: 'Cost',      v: fmtCost(t.cost) }
        ];
        // Tier B: present only when the extension has computed a drift result.
        if (model.drift) {
          const pct = Math.round(model.drift.score * 100);
          const cls = pct < 35 ? 'drift-low' : (pct < 70 ? 'drift-mid' : 'drift-high');
          stats.push({
            k: 'On-topic',
            v: pct + '% (' + model.drift.strategy + ')',
            cls
          });
        }

        root.innerHTML =
          '<div class="header">' +
            '<div class="objective">' + esc(objective) + '</div>' +
            '<div class="stats">' +
              stats.map(s =>
                '<div class="stat">' +
                  '<span class="k">' + esc(s.k) + '</span>' +
                  '<span class="v ' + (s.cls || '') + '">' + esc(s.v) + '</span>' +
                '</div>'
              ).join('') +
            '</div>' +
          '</div>' +
          flagsHtml +
          model.phases.map((p, i) => phaseBlock(p, i, grandTotalTokens)).join('');
      }

      function renderState(text) {
        root.innerHTML = '<div id="empty">' + esc(text) + '</div>';
      }

      // Single delegated listener for collapse toggles.
      root.addEventListener('click', (e) => {
        const head = e.target.closest && e.target.closest('.phase-head');
        if (!head) return;
        const idx = head.getAttribute('data-toggle');
        if (idx === null) return;
        const events = root.querySelector('.events[data-events="' + idx + '"]');
        head.classList.toggle('collapsed');
        if (events) events.classList.toggle('collapsed');
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'trace') render(msg.model);
        else if (msg.type === 'state') renderState(msg.text);
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
