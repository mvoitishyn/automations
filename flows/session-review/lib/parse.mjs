// Turn a Claude Code or pi session file into one normalized shape:
//   { harness, sessionId, file, cwd, title, start, end, models, tokens, cost,
//     turns: [{ at, prompt, actions: [{ tool, detail, error?, rejected? }], reply }] }
// A "turn" starts at each human prompt (including messages queued mid-turn).
import fs from 'node:fs';

const readLines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
      : '';

const one = (s, n = 160) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// A short, human-readable description of a tool call's input.
export function describeCall(name, input = {}) {
  const i = input || {};
  const p = i.file_path || i.path || i.filePath || i.notebook_path;
  if (i.command) return one(i.command, 200);
  if (p) return one(p, 200);
  if (i.pattern) return one(`${i.pattern}${i.path ? ' in ' + i.path : ''}`);
  if (i.url) return one(i.url);
  if (i.query) return one(i.query);
  if (i.description) return one(i.description);
  if (i.prompt) return one(i.prompt);
  if (i.skill) return one(i.skill);
  const first = Object.values(i).find((v) => typeof v === 'string');
  return one(first ?? '');
}

const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|str_replace|create)/i;

function newSession(harness, file) {
  return {
    harness,
    file,
    sessionId: null,
    cwd: null,
    title: null,
    start: null,
    end: null,
    models: new Set(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    turns: [],
    filesTouched: new Set(),
    compactions: 0,
  };
}

function finish(s) {
  s.models = [...s.models];
  s.filesTouched = [...s.filesTouched];
  s.prompts = s.turns.reduce((n, t) => n + 1 + (t.midTurn || 0), 0);
  s.toolCalls = s.turns.reduce((n, t) => n + t.actions.length, 0);
  s.toolErrors = s.turns.reduce((n, t) => n + t.actions.filter((a) => a.error).length, 0);
  s.rejections = s.turns.reduce((n, t) => n + t.actions.filter((a) => a.rejected).length, 0);
  s.interrupts = s.turns.filter((t) => t.interrupted).length;
  return s;
}

function stamp(s, ts) {
  if (!ts) return;
  const d = new Date(ts);
  if (Number.isNaN(+d)) return;
  if (!s.start || d < s.start) s.start = d;
  if (!s.end || d > s.end) s.end = d;
}

const isNoise = (t) =>
  !t.trim() ||
  /^<(local-command-|command-name|command-message|system-reminder|bash-input|bash-stdout|task-notification)/.test(
    t.trim(),
  ) ||
  /^Caveat: The messages below were generated/.test(t);

const REJECT = /doesn't want to proceed|was rejected|denied by|Permission for this action was denied/i;
const INTERRUPT = /^\[Request interrupted by user/;

export function parseClaude(file) {
  const s = newSession('claude', file);
  const calls = new Map(); // tool_use id -> action
  const seenMsg = new Set();
  let turn = null;
  const open = (at, prompt) => {
    turn = { at, prompt, actions: [], reply: '' };
    s.turns.push(turn);
  };
  for (const e of readLines(file)) {
    if (e.sessionId && !s.sessionId) s.sessionId = e.sessionId;
    if (e.cwd && !s.cwd) s.cwd = e.cwd;
    if (e.entrypoint && !s.entrypoint) s.entrypoint = e.entrypoint;
    if (e.type === 'ai-title' && e.aiTitle) s.title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) s.title = e.customTitle;
    if (e.isSidechain) continue;
    if (e.type === 'system' && e.subtype === 'compact_boundary') s.compactions++;
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.humanTurn) {
      stamp(s, e.timestamp);
      // Sent while the agent was still working: it steers the running turn.
      if (turn) {
        turn.prompt += `\n\n[sent mid-turn] ${e.attachment.prompt}`;
        turn.midTurn = (turn.midTurn || 0) + 1;
      } else open(e.timestamp, e.attachment.prompt);
      continue;
    }
    if (e.type === 'user' && e.message) {
      stamp(s, e.timestamp);
      const c = e.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const a = calls.get(b.tool_use_id);
          if (!a) continue;
          const out = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
          if (REJECT.test(out)) a.rejected = one(out, 200);
          else if (b.is_error) a.error = one(out, 300);
        }
        continue;
      }
      if (e.isMeta || e.isCompactSummary) continue;
      const t = textOf(c);
      if (INTERRUPT.test(t.trim())) {
        if (turn) turn.interrupted = true;
        continue;
      }
      if (isNoise(t)) continue;
      open(e.timestamp, t);
      continue;
    }
    if (e.type === 'assistant' && e.message) {
      stamp(s, e.timestamp);
      const m = e.message;
      if (m.model && m.model !== '<synthetic>') s.models.add(m.model);
      if (m.id && m.usage && !seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        s.tokens.input += m.usage.input_tokens || 0;
        s.tokens.output += m.usage.output_tokens || 0;
        s.tokens.cacheRead += m.usage.cache_read_input_tokens || 0;
        s.tokens.cacheWrite += m.usage.cache_creation_input_tokens || 0;
      }
      if (!turn) continue;
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text?.trim()) turn.reply = b.text;
        if (b.type === 'tool_use') {
          const a = { tool: b.name, detail: describeCall(b.name, b.input) };
          calls.set(b.id, a);
          turn.actions.push(a);
          const p = b.input?.file_path || b.input?.notebook_path;
          if (p && EDIT_TOOLS.test(b.name)) s.filesTouched.add(p);
        }
      }
    }
  }
  return finish(s);
}

export function parsePi(file) {
  const s = newSession('pi', file);
  const calls = new Map();
  let turn = null;
  for (const e of readLines(file)) {
    if (e.type === 'session') {
      s.sessionId = e.id;
      s.cwd = e.cwd;
      stamp(s, e.timestamp);
      continue;
    }
    if (e.type === 'session_info' && e.name) s.title = e.name;
    if (e.type === 'compaction') s.compactions++;
    if (e.type === 'model_change' && e.modelId) s.models.add(e.modelId);
    if (e.usage?.cost?.total && e.type !== 'message') s.cost += e.usage.cost.total;
    if (e.type !== 'message' || !e.message) continue;
    stamp(s, e.timestamp);
    const m = e.message;
    if (m.role === 'user') {
      const t = textOf(m.content);
      if (isNoise(t)) continue;
      turn = { at: e.timestamp, prompt: t, actions: [], reply: '' };
      s.turns.push(turn);
    } else if (m.role === 'assistant') {
      if (m.model) s.models.add(m.model);
      const u = m.usage || {};
      s.tokens.input += u.input || 0;
      s.tokens.output += u.output || 0;
      s.tokens.cacheRead += u.cacheRead || 0;
      s.tokens.cacheWrite += u.cacheWrite || 0;
      s.cost += u.cost?.total || 0;
      if (m.stopReason === 'aborted' && turn) turn.interrupted = true;
      if (!turn) continue;
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text?.trim()) turn.reply = b.text;
        if (b.type === 'toolCall') {
          const a = { tool: b.name, detail: describeCall(b.name, b.arguments) };
          calls.set(b.id, a);
          turn.actions.push(a);
          const p = b.arguments?.path || b.arguments?.file_path;
          if (p && EDIT_TOOLS.test(b.name)) s.filesTouched.add(p);
        }
      }
    } else if (m.role === 'toolResult') {
      const a = calls.get(m.toolCallId);
      if (!a) continue;
      const out = textOf(m.content);
      if (REJECT.test(out)) a.rejected = one(out, 200);
      else if (m.isError) a.error = one(out, 300);
    }
  }
  return finish(s);
}

export function parseSession(harness, file) {
  return harness === 'pi' ? parsePi(file) : parseClaude(file);
}
