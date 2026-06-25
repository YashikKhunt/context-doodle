// The webview is a sandboxed iframe — no `vscode` API, no fs access.
// Everything it knows about the outside world arrives via `window.message` events
// from the extension host, and it can only respond via `acquireVsCodeApi().postMessage`.
//
// We inline the HTML as a string (vs. a separate file) so the build stays single-bundle
// and the message contract sits next to the host code that produces it.

import * as vscode from 'vscode';

/**
 * Build the webview HTML with a strict CSP. The nonce gates the one inline <script>
 * we ship; nothing else (no external CDNs, no eval) is permitted.
 */
export function buildWebviewHtml(webview: vscode.Webview, nonce: string): string {
  const cspSource = webview.cspSource;

  // The blob is a single SVG <path>. The webview script smoothly tweens its scale
  // toward `targetFill` (0..1) using requestAnimationFrame.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Context Doodle</title>
  <style>
    :root { color-scheme: light dark; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    #stage {
      width: 100%;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* The blob lives inside an SVG viewBox of 200x200, centered at (100,100).
       We scale via the <g> transform so the path itself stays simple. */
    svg { width: 80%; max-width: 220px; height: auto; display: block; }
    /* Shake animation runs on the SVG element itself via CSS transform — the
       inner <g>'s SVG transform handles size/wobble independently, so the two
       compose without fighting each other. */
    @keyframes shake-warning {
      0%, 100% { transform: translateX(0) rotate(0); }
      20% { transform: translateX(-5px) rotate(-1.5deg); }
      40% { transform: translateX(5px) rotate(1.5deg); }
      60% { transform: translateX(-3px) rotate(-1deg); }
      80% { transform: translateX(3px) rotate(1deg); }
    }
    @keyframes shake-critical {
      0%, 100% { transform: translateX(0) rotate(0); }
      10% { transform: translateX(-9px) rotate(-3deg); }
      20% { transform: translateX(9px) rotate(3deg); }
      30% { transform: translateX(-7px) rotate(-2.5deg); }
      40% { transform: translateX(7px) rotate(2.5deg); }
      50% { transform: translateX(-5px) rotate(-2deg); }
      60% { transform: translateX(5px) rotate(2deg); }
      70% { transform: translateX(-3px) rotate(-1deg); }
      80% { transform: translateX(3px) rotate(1deg); }
    }
    svg.shake-warning { animation: shake-warning 0.45s ease-in-out infinite; }
    svg.shake-critical { animation: shake-critical 0.35s ease-in-out infinite; }
    #blob {
      fill: var(--vscode-charts-blue, #4ea1ff);
      opacity: 0.85;
      transition: fill 240ms ease;
    }
    #caption {
      font-size: 11px;
      opacity: 0.55;
      padding: 6px 8px 10px;
      text-align: center;
      user-select: none;
    }
  </style>
</head>
<body>
  <div id="stage">
    <svg id="blobSvg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-label="Context doodle">
      <g id="blobGroup" transform="translate(100 100) scale(1)">
        <!-- A friendly amoeba path centered around (0,0). -->
        <path id="blob" d="
          M 0 -60
          C 34 -60 64 -40 64 -8
          C 64 22 44 50 14 58
          C -16 66 -50 50 -60 22
          C -70 -6 -54 -42 -26 -54
          C -18 -58 -9 -60 0 -60 Z
        "/>
      </g>
    </svg>
  </div>
  <div id="caption">Context Doodle</div>

  <script nonce="${nonce}">
    (function () {
      // ----- webview side of the message-passing seam -----
      // The host posts: { type: 'fill', value: number 0..1 }
      // We tween a single number toward that target and re-render the blob scale.
      const vscode = acquireVsCodeApi();
      const blobSvg   = document.getElementById('blobSvg');
      const blobGroup = document.getElementById('blobGroup');
      const blobPath  = document.getElementById('blob');
      const caption   = document.getElementById('caption');
      let shakeTimeout = null;

      // current = what's drawn now; target = where we're heading.
      // The blob's resting size at fill=0 is MIN_SCALE; at fill=1 it's MAX_SCALE.
      const MIN_SCALE = 0.55;
      const MAX_SCALE = 1.25;
      let currentFill = 0;
      let targetFill  = 0;
      let lastMeta = null;

      function scaleFor(fill) {
        return MIN_SCALE + (MAX_SCALE - MIN_SCALE) * fill;
      }

      // Color shifts from calm blue → amber → red as fill rises.
      function colorFor(fill) {
        if (fill < 0.6) return 'var(--vscode-charts-blue, #4ea1ff)';
        if (fill < 0.85) return 'var(--vscode-charts-yellow, #e2c08d)';
        return 'var(--vscode-charts-red, #f48771)';
      }

      function render() {
        const s = scaleFor(currentFill);
        // A tiny breathing wobble so the blob feels alive even when idle.
        const wobble = 1 + Math.sin(performance.now() / 900) * 0.015;
        blobGroup.setAttribute('transform', 'translate(100 100) scale(' + (s * wobble).toFixed(4) + ')');
        blobPath.style.fill = colorFor(currentFill);
      }

      function tick() {
        // Critically-damped-ish ease: move ~12% of remaining distance per frame.
        currentFill += (targetFill - currentFill) * 0.12;
        render();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'fill') {
          targetFill = Math.max(0, Math.min(1, Number(msg.value) || 0));
          lastMeta = msg.meta || null;
          updateCaption();
        } else if (msg.type === 'state') {
          // Friendly text states (e.g., "Cline not detected").
          caption.textContent = String(msg.text || '');
        } else if (msg.type === 'shake') {
          // Threshold-crossing alert. The shake CSS classes are mutually
          // exclusive — clear both before applying the one we want.
          const sev = msg.severity === 'critical' ? 'critical' : 'warning';
          const duration = Math.max(200, Number(msg.durationMs) || 2000);
          blobSvg.classList.remove('shake-warning', 'shake-critical');
          // Force reflow so the animation restarts cleanly if a second alert
          // arrives mid-shake.
          void blobSvg.offsetWidth;
          blobSvg.classList.add('shake-' + sev);
          if (shakeTimeout) clearTimeout(shakeTimeout);
          shakeTimeout = setTimeout(() => {
            blobSvg.classList.remove('shake-warning', 'shake-critical');
            shakeTimeout = null;
          }, duration);
        }
      });

      function updateCaption() {
        if (!lastMeta) { caption.textContent = ''; return; }
        const pct = Math.round((lastMeta.fillRatio ?? targetFill) * 100);
        const used = lastMeta.contextUsed;
        const max  = lastMeta.contextWindowMax;
        if (typeof used === 'number' && typeof max === 'number') {
          caption.textContent = used.toLocaleString() + ' / ' + max.toLocaleString() + ' tokens (' + pct + '%)';
          caption.title = caption.textContent;
        } else {
          caption.textContent = pct + '%';
        }
      }

      // Let the host know we're ready to receive an initial value.
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

export function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
