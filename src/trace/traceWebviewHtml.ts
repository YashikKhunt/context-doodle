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
      padding: 8px 4px 6px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      z-index: 1;
    }
    .header .objective { font-weight: 600; word-break: break-word; }
    .header .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
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
        return (
          '<div class="event ' + ev.kind + '">' +
            '<span class="icon">' + icon + '</span>' +
            '<span class="label">' + esc(ev.label || ev.kind) + '</span>' +
            '<span class="delta">' + esc(delta) + '</span>' +
          '</div>'
        );
      }

      function phaseBlock(phase, idx) {
        const totals =
          'in ' + fmtTokens(phase.tokensIn) +
          ' · out ' + fmtTokens(phase.tokensOut) +
          (phase.toolCalls ? ' · ' + phase.toolCalls + ' tool' : '') +
          (phase.errors ? ' · ' + phase.errors + ' err' : '');
        const modeClass = 'mode ' + esc(phase.mode);
        return (
          '<div class="phase" data-phase="' + idx + '">' +
            '<div class="phase-head" data-toggle="' + idx + '">' +
              '<span class="chev">▾</span>' +
              '<span class="' + modeClass + '">' + esc(phase.mode) + '</span>' +
              '<span class="totals">' + totals + '</span>' +
            '</div>' +
            '<div class="events" data-events="' + idx + '">' +
              phase.events.map(eventRow).join('') +
            '</div>' +
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
        const meta =
          model.phases.length + ' phase' + (model.phases.length === 1 ? '' : 's') +
          ' · ' + t.llmCalls + ' LLM call' + (t.llmCalls === 1 ? '' : 's') +
          ' · ' + fmtTokens(t.tokensIn + t.cacheReads) + ' in / ' + fmtTokens(t.tokensOut) + ' out' +
          (t.errors ? ' · ' + t.errors + ' error' + (t.errors === 1 ? '' : 's') : '');

        root.innerHTML =
          '<div class="header">' +
            '<div class="objective">' + esc(objective) + '</div>' +
            '<div class="meta">' + meta + '</div>' +
          '</div>' +
          model.phases.map(phaseBlock).join('');
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
