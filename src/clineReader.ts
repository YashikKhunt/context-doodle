// Reads Cline's on-disk per-task state to derive a current "context fill" number.
//
// Cline (saoudrizwan.claude-dev) stores per-task UI event logs at:
//   <globalStorage>/saoudrizwan.claude-dev/tasks/<task-id>/ui_messages.json
//
// Each entry with `say === 'api_req_started'` has a `text` field that is itself
// a JSON-encoded payload: { tokensIn, tokensOut, cacheReads, cacheWrites, cost, apiProtocol }.
// We treat the LAST such entry as the current request, and define
//   contextUsed = tokensIn + cacheReads
// which is the approximation Cline's UI itself uses for the context bar.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface NewestTask {
  taskId: string;
  uiMessagesPath: string;
  mtimeMs: number;
}

/**
 * Resolve the watched extension's globalStorage directory.
 *
 * Primary trick: VS Code lays out per-extension storage as siblings under
 * `User/globalStorage/`. Our own `context.globalStorageUri.fsPath` ends in
 * `.../globalStorage/<ourId>/`, so `..` + target id gives us the neighbor —
 * regardless of OS or VS Code variant (Code, Code - Insiders, VSCodium, Cursor, etc.).
 *
 * Fallback: probe the canonical OS-specific paths for stock VS Code.
 */
export function resolveTargetStorageDir(
  context: vscode.ExtensionContext,
  targetExtensionId: string
): string | undefined {
  const sibling = path.join(context.globalStorageUri.fsPath, '..', targetExtensionId);
  if (safeExists(sibling)) return sibling;

  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', targetExtensionId)
    );
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) {
      candidates.push(path.join(appdata, 'Code', 'User', 'globalStorage', targetExtensionId));
    }
  } else {
    candidates.push(path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', targetExtensionId));
  }

  for (const c of candidates) {
    if (safeExists(c)) return c;
  }
  return undefined;
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Find the most-recently-active task directory by `ui_messages.json` mtime.
 * Returns undefined if `tasks/` is missing or has no readable entries.
 */
export async function findNewestTask(storageRoot: string): Promise<NewestTask | undefined> {
  const tasksDir = path.join(storageRoot, 'tasks');
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(tasksDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let best: NewestTask | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uiPath = path.join(tasksDir, entry.name, 'ui_messages.json');
    try {
      const stat = await fsp.stat(uiPath);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { taskId: entry.name, uiMessagesPath: uiPath, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Task dir without a ui_messages.json yet — skip.
    }
  }
  return best;
}

interface ApiReqStartedPayload {
  tokensIn?: number;
  tokensOut?: number;
  cacheReads?: number;
  cacheWrites?: number;
  cost?: number;
  apiProtocol?: string;
}

interface UiEvent {
  say?: string;
  text?: string;
}

/**
 * Read the latest `api_req_started` payload from a ui_messages.json file and
 * return the implied `contextUsed` (tokensIn + cacheReads).
 *
 * Returns:
 *   - a number ≥ 0 when the file parsed successfully.
 *   - `undefined` if the file is unreadable or mid-write (caller should keep
 *     the previous value rather than flicker to 0).
 *   - 0 when the file is valid but has no api_req_started yet (brand-new task).
 */
export async function readContextUsed(uiMessagesPath: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(uiMessagesPath, 'utf8');
  } catch {
    return undefined;
  }

  let events: UiEvent[];
  try {
    events = JSON.parse(raw) as UiEvent[];
  } catch {
    // Caught mid-write — keep last good value.
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.say === 'api_req_started' && typeof ev.text === 'string') {
      try {
        const payload = JSON.parse(ev.text) as ApiReqStartedPayload;
        const tokensIn = numberOr0(payload.tokensIn);
        const cacheReads = numberOr0(payload.cacheReads);
        return tokensIn + cacheReads;
      } catch {
        // Malformed inner JSON — keep scanning earlier events.
      }
    }
  }
  return 0;
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
