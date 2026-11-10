#!/usr/bin/env node
/**
 * Summarize and analyse coding-agent sessions (Claude Code, pi) into Obsidian.
 *
 *   session-review hook claude          SessionEnd hook: reads the hook JSON on stdin, queues, returns at once
 *   session-review enqueue <harness> <file>   queue a session and start the worker in the background
 *   session-review review <harness> <file> [--force]   review one session now (foreground)
 *   session-review sweep [--days N]     queue every settled session without an up-to-date note, then drain
 *   session-review drain                process the queue (one worker at a time; used by the hooks)
 *   session-review status               health check: hooks, timer, model, queue, recent runs
 *   session-review last [N]             print the last N notes written
 *
 * Work sessions are reviewed by the local Ollama model; personal ones by Claude.
 * Routing lives in ~/.config/session-review/config.json (see lib/config.mjs).
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, routeFor, STATE_DIR } from '../lib/config.mjs';
import { healthy } from '../lib/llm.mjs';
import { loadIndex, reviewFile } from '../lib/review.mjs';

const SELF = fs.realpathSync(new URL(import.meta.url).pathname);
const QUEUE = path.join(STATE_DIR, 'queue');
const LOCK = path.join(STATE_DIR, 'worker.lock');
const LOG = path.join(STATE_DIR, 'log.jsonl');
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PI_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi/agent');

fs.mkdirSync(QUEUE, { recursive: true });
// `session-review status | head` closes the pipe early: exit quietly instead of crashing.
process.stdout.on('error', (err) => (err.code === 'EPIPE' ? process.exit(0) : (process.exitCode = 1)));

const logEvent = (e) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
const say = (m) => process.stderr.write(m + '\n');

function notify(title, body, urgency = 'low') {
  if (!loadConfig().notify) return;
  try {
    spawn('notify-send', ['--app-name=session-review', `--urgency=${urgency}`, title, body], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    /* no notification daemon: fine */
  }
}

function enqueue(harness, file) {
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error(`no such session file: ${file}`);
  const id = crypto.createHash('sha1').update(`${harness}:${file}`).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(QUEUE, id + '.json'), JSON.stringify({ harness, file, queuedAt: Date.now() }));
}

function startWorker() {
  spawn(process.execPath, [SELF, 'drain'], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, SESSION_REVIEW_CHILD: '1' },
  }).unref();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function takeLock() {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && alive(pid)) return false;
    fs.rmSync(LOCK, { force: true }); // stale lock from a crashed worker
    return takeLock();
  }
}

async function drain() {
  if (!takeLock()) return say('another worker is running; it will pick the queue up');
  try {
    for (;;) {
      const items = fs
        .readdirSync(QUEUE)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(QUEUE, f), 'utf8')) }))
        .sort((a, b) => a.queuedAt - b.queuedAt);
      if (!items.length) break;
      for (const it of items) {
        fs.rmSync(path.join(QUEUE, it.f), { force: true });
        await runOne(it.harness, it.file, false);
      }
    }
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

async function runOne(harness, file, force) {
  const t0 = Date.now();
  try {
    const r = await reviewFile(harness, file, { force, log: say });
    logEvent({ harness, file, ...r, ms: Date.now() - t0 });
    if (r.status === 'written') {
      say(`✓ ${r.note}`);
      notify('Session reviewed', `${r.title}\n→ ${r.kind} vault (${r.backend})`);
    } else say(`- ${r.status}${r.reason ? ': ' + r.reason : ''}`);
    return r;
  } catch (err) {
    logEvent({ harness, file, status: 'error', error: String(err.message || err), ms: Date.now() - t0 });
    say(`✗ ${file}: ${err.message}`);
    notify('Session review failed', `${path.basename(file)}: ${String(err.message).slice(0, 200)}`, 'normal');
    return { status: 'error' };
  }
}

// --- finding sessions -------------------------------------------------------

function listFiles(dir, depth) {
  const out = [];
  const walk = (d, n) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && n > 1) walk(p, n - 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

function candidates(days) {
  const since = Date.now() - days * 86_400_000;
  // Claude: ~/.claude/projects/<project>/<session>.jsonl (subagent logs live deeper and are skipped).
  const claude = listFiles(path.join(CLAUDE_DIR, 'projects'), 2).map((f) => ['claude', f]);
  const pi = listFiles(path.join(PI_DIR, 'sessions'), 2).map((f) => ['pi', f]);
  return [...claude, ...pi]
    .map(([h, f]) => ({ h, f, m: fs.statSync(f).mtimeMs }))
    .filter((x) => x.m >= since);
}

async function sweep(days) {
  const cfg = loadConfig();
  const settled = Date.now() - cfg.settleMinutes * 60_000;
  const idx = loadIndex();
  let n = 0;
  for (const c of candidates(days)) {
    if (c.m > settled) continue; // probably still open; its hook or a later sweep will get it
    const prev = idx[`${c.h}:${c.f}`];
    if (prev && prev.mtimeMs >= c.m) continue;
    enqueue(c.h, c.f);
    n++;
  }
  say(`sweep: queued ${n} session(s)`);
  await drain();
}

// --- hook entry points -------------------------------------------------------

async function hookClaude() {
  let raw = '';
  for await (const d of process.stdin) raw += d;
  const j = JSON.parse(raw || '{}');
  if (!j.transcript_path) return;
  enqueue('claude', j.transcript_path);
  startWorker();
}

// --- status ------------------------------------------------------------------

async function status() {
  const cfg = loadConfig();
  const ok = (b, m) => console.log(`${b ? '✓' : '✗'} ${m}`);
  ok(true, `config: ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : 'built-in defaults (no config file)'}`);
  const skip = (m) => console.log(`– ${m}`);
  if (fs.existsSync(CLAUDE_DIR)) {
    let hooked = false;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
      hooked = JSON.stringify(s.hooks?.SessionEnd || []).includes('session-review');
    } catch {}
    ok(hooked, 'Claude Code SessionEnd hook');
  } else skip('Claude Code not installed');
  if (fs.existsSync(PI_DIR)) {
    const ext = path.join(PI_DIR, 'extensions', 'session-review.ts');
    ok(fs.existsSync(ext), `pi extension (${ext})`);
  } else skip('pi not installed');
  let timer = null;
  try {
    timer =
      execFileSync('systemctl', ['--user', 'is-active', 'session-review-sweep.timer'], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() === 'active';
  } catch (err) {
    timer = err.stdout?.toString().trim() ? false : null; // no output at all: no systemd user session
  }
  if (timer === null) skip('no systemd user session: run `session-review sweep` from cron for the safety net');
  else ok(timer, 'sweep timer (systemd --user session-review-sweep.timer)');
  for (const [name, b] of Object.entries(cfg.backends))
    if (b.type !== 'claude') ok(await healthy(b), `backend ${name}: ${b.model} @ ${b.url}`);
  for (const r of [...cfg.routes, { match: '(default)', ...cfg.default }]) {
    const via = [].concat(r.backend).join(' → ');
    if (!r.vault) {
      ok(false, `${r.match} → no vault set; edit ${CONFIG_FILE}`);
      continue;
    }
    const v = routeFor({ ...cfg, routes: [], default: r }, '/');
    const isVault = fs.existsSync(path.join(v.vault, '.obsidian'));
    ok(isVault, `${r.match} → ${v.vault}/${r.folder} via ${via}${isVault ? '' : ' (not an Obsidian vault yet)'}`);
  }
  const queued = fs.readdirSync(QUEUE).length;
  ok(queued === 0 || fs.existsSync(LOCK), `queue: ${queued} waiting${fs.existsSync(LOCK) ? ', worker running' : ''}`);
  const idx = loadIndex();
  const settled = Date.now() - cfg.settleMinutes * 60_000;
  const backlog = candidates(cfg.sweepDays).filter((c) => c.m <= settled && !(idx[`${c.h}:${c.f}`]?.mtimeMs >= c.m));
  ok(backlog.length === 0, `unreviewed settled sessions (last ${cfg.sweepDays}d): ${backlog.length}`);
  const recent = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-8).map(JSON.parse) : [];
  console.log('\nrecent runs:');
  for (const e of recent)
    console.log(`  ${e.at.slice(0, 16)} ${e.status.padEnd(10)} ${e.title || e.reason || e.error || path.basename(e.file)}`);
}

// --- main --------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name, d) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : d;
};

try {
  if (cmd === 'hook') {
    // Never let a review session trigger another review, and never fail the agent's exit.
    if (process.env.SESSION_REVIEW_CHILD) process.exit(0);
    if (rest[0] === 'claude') await hookClaude();
  } else if (cmd === 'enqueue') {
    if (process.env.SESSION_REVIEW_CHILD) process.exit(0);
    enqueue(rest[0], rest[1]);
    startWorker();
  } else if (cmd === 'review') {
    const r = await runOne(rest[0], path.resolve(rest[1]), flag('--force'));
    process.exitCode = r.status === 'error' ? 1 : 0;
  } else if (cmd === 'sweep') await sweep(Number(opt('--days', loadConfig().sweepDays)));
  else if (cmd === 'drain') await drain();
  else if (cmd === 'status') await status();
  else if (cmd === 'last') {
    const idx = Object.values(loadIndex())
      .filter((v) => v.note)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    for (const v of idx.slice(0, Number(rest[0] || 5))) console.log(`${v.at.slice(0, 16)}  ${v.kind}  ${v.note}`);
  } else {
    console.log(fs.readFileSync(SELF, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''));
  }
} catch (err) {
  say(`session-review: ${err.message}`);
  if (cmd !== 'hook') process.exitCode = 1;
}
