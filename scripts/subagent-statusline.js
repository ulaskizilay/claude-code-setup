#!/usr/bin/env node
// Claude Code subagentStatusLine renderer.
// Reads one JSON payload on stdin (`columns` + `tasks[]`) and emits one
// JSON line per task to override that task's row: {"id", "content"}.
// Tasks with no emitted id keep Claude Code's default row rendering.

'use strict';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const ROW_SEP = `${DIM} · ${RESET}`;

const STATUS_MARK = {
  completed: `${GREEN}✓${RESET}`,
  failed: `${RED}✗${RESET}`,
  running: `${CYAN}▸${RESET}`,
};

function colorForPct(pct) {
  if (pct >= 90) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}

function kfmt(n) {
  if (typeof n !== 'number') return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function renderTaskRow(task, cols) {
  const parts = [STATUS_MARK[task.status] || `${DIM}·${RESET}`];

  parts.push(`${CYAN}${truncate(task.name || task.type || 'agent', 18)}${RESET}`);

  const description = task.description || task.label;
  if (description) parts.push(`${DIM}${truncate(description, cols < 80 ? 24 : 44)}${RESET}`);

  if (typeof task.tokenCount === 'number') {
    if (typeof task.contextWindowSize === 'number' && task.contextWindowSize > 0) {
      const pct = Math.round((task.tokenCount / task.contextWindowSize) * 100);
      parts.push(`${colorForPct(pct)}${pct}%${RESET} ${DIM}${kfmt(task.tokenCount)}${RESET}`);
    } else {
      parts.push(`${DIM}${kfmt(task.tokenCount)} tok${RESET}`);
    }
  }

  const meta = [];
  if (task.model) meta.push(String(task.model).replace(/^claude-/, ''));
  if (task.effort) meta.push(String(task.effort));
  if (meta.length) parts.push(`${DIM}${meta.join(' ')}${RESET}`);

  return parts.join(ROW_SEP);
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const cols = data.columns || 80;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];

  for (const task of tasks) {
    if (!task?.id) continue;
    process.stdout.write(JSON.stringify({ id: task.id, content: renderTaskRow(task, cols) }) + '\n');
  }
});
