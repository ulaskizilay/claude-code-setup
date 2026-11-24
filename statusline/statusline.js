#!/usr/bin/env node
// Claude Code statusLine renderer.
// Reads the hook payload Claude Code pipes in on stdin and writes a
// two-line, ANSI-colored summary to stdout.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';

const SEP = `${DIM} | ${RESET}`;
const CONTEXT_BAR_WIDTH = 10;
const GIT_CACHE_TTL_MS = 5000;

const PR_STATE_MARK = {
  approved: `${GREEN}✓${RESET}`,
  changes_requested: `${RED}✗${RESET}`,
  pending: `${YELLOW}•${RESET}`,
  draft: `${DIM}◦${RESET}`,
};

function colorForPct(pct) {
  if (pct === null || pct === undefined) return DIM;
  if (pct >= 90) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + '…';
}

function kfmt(n) {
  if (n === null || n === undefined) return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

// Renders a countdown as "2d 4h" / "3h 12m" / "8m" from a unix-seconds timestamp.
function untilStr(resetsAt) {
  if (typeof resetsAt !== 'number') return null;
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function osc8(url, text) {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Resolves branch/ahead/behind/staged/modified/untracked via a single
// `git status --porcelain=v2 --branch` call, cached per session on disk
// so repeated status-line refreshes don't re-shell out every ~second.
function cachedGit(cwd, sessionId) {
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-git-${sessionId || 'nosession'}`);

  try {
    const stat = fs.statSync(cacheFile);
    if (Date.now() - stat.mtimeMs < GIT_CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {
    // No cache yet, or it's stale enough to ignore.
  }

  const info = { branch: '', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 };
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain=v2', '--branch'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString();

    for (const line of output.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const branch = line.slice('# branch.head '.length).trim();
        info.branch = branch === '(detached)' ? '' : branch;
      } else if (line.startsWith('# branch.ab ')) {
        const match = line.match(/\+(\d+)\s+-(\d+)/);
        if (match) {
          info.ahead = +match[1];
          info.behind = +match[2];
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const xy = line.split(' ')[1] || '..';
        if (xy[0] !== '.') info.staged++;
        if (xy[1] !== '.') info.modified++;
      } else if (line.startsWith('u ')) {
        info.modified++;
      } else if (line.startsWith('? ')) {
        info.untracked++;
      }
    }
  } catch {
    // Not a git repo, or git isn't available — fall back to empty info.
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(info));
  } catch {
    // Cache write failure is non-fatal; next call just re-runs git.
  }
  return info;
}

const REVIEW_CACHE_TTL_MS = 120000;
// A failed lookup (CLI missing, not logged in, unreachable host) is retried less
// often, so a broken setup costs one timeout every 10 minutes, not every 2.
const REVIEW_ERROR_TTL_MS = 600000;
const REVIEW_CLI_TIMEOUT_MS = 3000;

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: REVIEW_CLI_TIMEOUT_MS,
    // glab ignores SIGTERM while waiting on an unreachable host; only SIGKILL
    // actually enforces the timeout.
    killSignal: 'SIGKILL',
  }).toString().trim();
}

// The remote the branch tracks, else "origin", else the first remote.
function reviewRemoteUrl(cwd) {
  let remote = '';
  try {
    remote = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).split('/')[0];
  } catch {
    // No upstream configured.
  }
  if (!remote) {
    try {
      const remotes = run('git', ['remote'], cwd).split('\n').filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch {
      return null;
    }
  }
  if (!remote) return null;
  try {
    return run('git', ['remote', 'get-url', remote], cwd);
  } catch {
    return null;
  }
}

// "git@host:group/repo.git" or "https://host/group/repo" -> { host, repoPath }
function parseRemote(url) {
  const match = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  return match ? { host: match[1].toLowerCase(), repoPath: match[2] } : null;
}

function githubPullRequest(cwd, repoPath, branch) {
  const output = run('gh', ['pr', 'list', '--repo', repoPath, '--head', branch, '--state', 'open',
    '--limit', '1', '--json', 'number,url,isDraft,reviewDecision'], cwd);
  const list = JSON.parse(output);
  if (!Array.isArray(list)) throw new Error('unexpected gh output');
  const pr = list[0];
  if (!pr) return null;
  let reviewState = 'pending';
  if (pr.isDraft) reviewState = 'draft';
  else if (pr.reviewDecision === 'APPROVED') reviewState = 'approved';
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') reviewState = 'changes_requested';
  return { kind: 'PR', ref: `#${pr.number}`, url: pr.url, review_state: reviewState };
}

const GITLAB_BLOCKING_STATUSES = new Set([
  'requested_changes', 'conflict', 'discussions_not_resolved', 'need_rebase', 'blocked_status',
]);

function gitlabMergeRequest(cwd, remoteUrl, branch) {
  const output = run('glab', ['mr', 'list', '--repo', remoteUrl, '--source-branch', branch,
    '--per-page', '1', '--output', 'json'], cwd);
  const list = JSON.parse(output);
  if (!Array.isArray(list)) throw new Error('unexpected glab output');
  const mr = list[0];
  if (!mr) return null;
  let reviewState = 'pending';
  if (mr.draft) reviewState = 'draft';
  else if (mr.detailed_merge_status === 'mergeable') reviewState = 'approved';
  else if (GITLAB_BLOCKING_STATUSES.has(mr.detailed_merge_status)) reviewState = 'changes_requested';
  return { kind: 'MR', ref: `!${mr.iid}`, url: mr.web_url, review_state: reviewState };
}

// Claude Code's payload carries no PR/MR info, so ask the forge's CLI about the
// current branch: `gh` for github.com, `glab` for any other host (gitlab.com or
// self-hosted). Cached per repo+branch, misses included, so the CLI runs at most
// once every two minutes (failures: every ten). Missing or logged-out CLIs
// just show nothing.
function cachedReview(cwd, branch) {
  const key = `${cwd}:${branch}`.replace(/[^a-zA-Z0-9]+/g, '_').slice(-120);
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-review-${key}`);

  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - cached.at < cached.ttl) return cached.review;
  } catch {
    // No cache yet, or it's unreadable.
  }

  let review = null;
  let ttl = REVIEW_CACHE_TTL_MS;
  try {
    const remoteUrl = reviewRemoteUrl(cwd);
    const remote = remoteUrl && parseRemote(remoteUrl);
    if (remote?.host === 'github.com') review = githubPullRequest(cwd, remote.repoPath, branch);
    else if (remote) review = gitlabMergeRequest(cwd, remoteUrl, branch);
  } catch {
    // CLI missing, not logged in, unreachable or timed out.
    ttl = REVIEW_ERROR_TTL_MS;
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), ttl, review }));
  } catch {
    // Non-fatal; next refresh retries.
  }
  return review;
}

function buildLine1(data, narrow) {
  const line = [];

  const modelName = data.model?.display_name || data.model?.id || 'Claude';
  line.push(`${CYAN}${truncate(modelName, 20)}${RESET}`);

  const cwd = data.workspace?.current_dir || data.cwd;
  if (cwd) {
    const dirName = truncate(path.basename(cwd.replace(/[\\/]+$/, '')) || cwd, narrow ? 14 : 24);
    const worktree = data.workspace?.git_worktree;
    let label = `${BLUE}${dirName}${RESET}`;
    if (worktree) label += `${DIM}/${RESET}${MAGENTA}${truncate(worktree, 16)}${RESET}`;
    line.push(`${DIM}📁 ${RESET}${label}`);
  }

  const git = cwd ? cachedGit(cwd, data.session_id) : null;
  if (git?.branch) {
    let segment = `${DIM}⎇ ${RESET}${YELLOW}${truncate(git.branch, narrow ? 16 : 28)}${RESET}`;

    const aheadBehind = [];
    if (git.ahead > 0) aheadBehind.push(`↑${git.ahead}`);
    if (git.behind > 0) aheadBehind.push(`↓${git.behind}`);
    if (aheadBehind.length) segment += ` ${CYAN}${aheadBehind.join('')}${RESET}`;

    const workingCopy = [];
    if (git.staged > 0) workingCopy.push(`${GREEN}+${git.staged}${RESET}`);
    if (git.modified > 0) workingCopy.push(`${YELLOW}~${git.modified}${RESET}`);
    if (git.untracked > 0) workingCopy.push(`${DIM}?${git.untracked}${RESET}`);
    if (workingCopy.length) segment += ` ${workingCopy.join('')}`;

    line.push(segment);
  }

  const review = data.pr?.number
    ? { kind: 'PR', ref: `#${data.pr.number}`, url: data.pr.url, review_state: data.pr.review_state }
    : (git?.branch ? cachedReview(cwd, git.branch) : null);
  if (review) {
    const stateMark = PR_STATE_MARK[review.review_state] || '';
    const label = review.url ? osc8(review.url, review.ref) : review.ref;
    line.push(`${DIM}${review.kind} ${RESET}${label}${stateMark ? ' ' + stateMark : ''}`);
  }

  const modeBits = [];
  if (data.effort?.level) modeBits.push(data.effort.level);
  if (data.fast_mode) modeBits.push('⚡fast');
  if (modeBits.length) line.push(`${DIM}${modeBits.join(' ')}${RESET}`);

  return line;
}

function limitSegment(label, limit, narrow) {
  if (typeof limit?.used_percentage !== 'number') return `${DIM}${label}: n/a${RESET}`;
  const pct = Math.round(limit.used_percentage);
  const until = untilStr(limit.resets_at);
  const tail = until && !narrow ? ` ${DIM}(${until})${RESET}` : '';
  return `${colorForPct(pct)}${label}: ${pct}%${RESET}${tail}`;
}

function buildLine2(data, narrow) {
  const line = [];

  const ctx = data.context_window;
  if (typeof ctx?.used_percentage === 'number') {
    const pct = Math.round(ctx.used_percentage);
    const filled = Math.max(0, Math.min(CONTEXT_BAR_WIDTH, Math.round((pct / 100) * CONTEXT_BAR_WIDTH)));
    const bar = '▓'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled);
    let segment = `${colorForPct(pct)}${bar} ${pct}%${RESET}`;

    const notes = [];
    if (typeof ctx.context_window_size === 'number' && typeof ctx.total_input_tokens === 'number' && ctx.context_window_size > 0) {
      const left = Math.max(0, ctx.context_window_size - ctx.total_input_tokens);
      notes.push(`${kfmt(left)} left`);
    }
    // On 1M-token windows, past 200k input tokens is informational (long-context
    // pricing), not a capacity problem, so it's a dim note rather than an alarm.
    if (data.exceeds_200k_tokens) notes.push('200k+');
    if (notes.length) segment += ` ${DIM}(${notes.join(' · ')})${RESET}`;
    line.push(segment);
  } else {
    line.push(`${DIM}ctx: n/a${RESET}`);
  }

  const rateLimits = data.rate_limits || {};
  line.push(limitSegment('5h', rateLimits.five_hour, narrow));
  line.push(limitSegment('7d', rateLimits.seven_day, narrow));

  const cost = data.cost || {};
  if (!narrow && typeof cost.total_cost_usd === 'number') {
    const totalMinutes = Math.floor((cost.total_duration_ms || 0) / 60000);
    const durationStr = totalMinutes >= 60
      ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
      : `${totalMinutes}m`;
    line.push(`${DIM}$${cost.total_cost_usd.toFixed(2)} · ${durationStr}${RESET}`);
  }

  if (!narrow) {
    const added = cost.total_lines_added || 0;
    const removed = cost.total_lines_removed || 0;
    if (added || removed) line.push(`${GREEN}+${added}${RESET} ${RED}-${removed}${RESET}`);
  }

  return line;
}

function render(data) {
  const cols = parseInt(process.env.COLUMNS || '0', 10) || 120;
  const narrow = cols < 90;
  const line1 = buildLine1(data, narrow);
  const line2 = buildLine2(data, narrow);
  return line1.join(SEP) + '\n' + line2.join(SEP);
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stdout.write('Claude');
    return;
  }
  process.stdout.write(render(data));
});
