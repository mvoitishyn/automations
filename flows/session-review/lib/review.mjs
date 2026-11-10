// Review one session file and write (or rewrite) its note in the right vault.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, routeFor, STATE_DIR } from './config.mjs';
import { parseSession } from './parse.mjs';
import { chunks, chunkPrompt, finalPrompt, header, SYSTEM } from './digest.mjs';
import { pickBackend } from './llm.mjs';
import { redact } from './redact.mjs';

const INDEX = path.join(STATE_DIR, 'index.json');

export function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex(idx) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(INDEX + '.tmp', JSON.stringify(idx, null, 1));
  fs.renameSync(INDEX + '.tmp', INDEX);
}

const safe = (s) =>
  String(s)
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

const yamlStr = (s) => JSON.stringify(String(s ?? ''));

function parseAnswer(text) {
  const get = (k) => text.match(new RegExp(`^\\s*\\**${k}\\**:\\s*(.+)$`, 'im'))?.[1]?.trim();
  const i = text.search(/^## /m);
  return {
    title: get('TITLE')?.replace(/^["'<]|["'>]$/g, ''),
    outcome: get('OUTCOME')
      ?.toLowerCase()
      .match(/done|partial|abandoned|exploratory/)?.[0],
    tags: (get('TAGS') || '')
      .split(',')
      .map((t) =>
        t
          .trim()
          .toLowerCase()
          .replace(/^#/, '')
          .replace(/[^a-z0-9/_-]+/g, '-')
          .replace(/^-|-$/g, ''),
      )
      .filter(Boolean)
      .slice(0, 6),
    body: (i >= 0 ? text.slice(i) : text).trim(),
  };
}

const quote = (s) =>
  String(s)
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');

const capped = (s, n) => {
  const t = redact(String(s ?? '').trim());
  return t.length > n ? t.slice(0, n) + ' …' : t;
};

function render(s, a, reviewer, myNotes) {
  const mins = s.start && s.end ? Math.round((s.end - s.start) / 60000) : 0;
  const project = path.basename(s.cwd || '') || 'unknown';
  const when = s.start ? s.start.toISOString() : '';
  const local = s.start ? new Date(s.start).toLocaleString('sv-SE').slice(0, 16) : '';
  const tags = ['agent-session', s.harness, ...a.tags.filter((t) => t !== 'agent-session' && t !== s.harness)];
  const fm = [
    '---',
    'type: agent-session',
    `title: ${yamlStr(a.title)}`,
    `harness: ${s.harness}`,
    `project: ${yamlStr(project)}`,
    `cwd: ${yamlStr(s.cwd)}`,
    `session_id: ${yamlStr(s.sessionId)}`,
    `date: ${local.slice(0, 10)}`,
    `started: ${when}`,
    `duration_min: ${mins}`,
    `models: [${s.models.map(yamlStr).join(', ')}]`,
    `outcome: ${a.outcome || 'unknown'}`,
    `prompts: ${s.prompts}`,
    `tool_calls: ${s.toolCalls}`,
    `tool_errors: ${s.toolErrors}`,
    `rejected_calls: ${s.rejections}`,
    `interrupts: ${s.interrupts}`,
    `tokens_in: ${s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite}`,
    `tokens_out: ${s.tokens.output}`,
    ...(s.cost ? [`cost_usd: ${s.cost.toFixed(3)}`] : []),
    `reviewed_by: ${yamlStr(reviewer)}`,
    `reviewed_at: ${new Date().toISOString()}`,
    `tags: [${tags.join(', ')}]`,
    '---',
  ];
  const errs = s.toolErrors ? ` (${s.toolErrors} failed)` : '';
  const out = [
    ...fm,
    '',
    `# ${a.title}`,
    '',
    `> [!info] ${s.harness} · ${project} · ${local} · ${mins} min · ${s.prompts} prompts · ${s.toolCalls} tool calls${errs} · outcome: ${a.outcome || 'unknown'}`,
    '',
    a.body,
    '',
  ];
  if (s.filesTouched.length) {
    out.push('## Files changed', '');
    for (const f of s.filesTouched) out.push(`- \`${s.cwd && f.startsWith(s.cwd + '/') ? f.slice(s.cwd.length + 1) : f}\``);
    out.push('');
  }
  out.push('## Conversation', '', `> [!quote]- ${s.turns.length} prompts and replies`);
  s.turns.forEach((t, i) => {
    const at = t.at ? new Date(t.at).toTimeString().slice(0, 5) : '';
    out.push('>', `> **${i + 1}. ${at} — prompt**`, quote(capped(t.prompt, 1500)));
    const acts = t.actions.length ? ` · ${t.actions.length} tool calls` : '';
    const bad = t.actions.filter((x) => x.error || x.rejected).length;
    if (t.reply || acts)
      out.push(
        '>',
        `> **reply**${acts}${bad ? ` (${bad} failed/rejected)` : ''}${t.interrupted ? ' · interrupted' : ''}`,
        quote(capped(t.reply || '(no text reply)', 800)),
      );
  });
  out.push('', '## My notes', '', myNotes || '', '', '---', `Transcript: \`${s.file}\``, '');
  return out.join('\n');
}

function readMyNotes(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const m = t.match(/\n## My notes\n([\s\S]*?)\n---\nTranscript:/);
    return m?.[1].trim() || '';
  } catch {
    return '';
  }
}

export async function reviewFile(harness, file, { force = false, log = () => {} } = {}) {
  const cfg = loadConfig();
  const st = fs.statSync(file);
  const idx = loadIndex();
  const key = `${harness}:${file}`;
  const prev = idx[key];
  if (!force && prev && prev.mtimeMs >= st.mtimeMs) return { status: 'up-to-date', note: prev.note };

  const s = parseSession(harness, file);
  if (!force && s.entrypoint && s.entrypoint !== 'cli') {
    idx[key] = { ...prev, mtimeMs: st.mtimeMs, skipped: 'headless' };
    saveIndex(idx);
    return { status: 'skipped', reason: `headless session (${s.entrypoint})` };
  }
  if (s.prompts < cfg.minPrompts) {
    idx[key] = { ...prev, mtimeMs: st.mtimeMs, skipped: 'no prompts' };
    saveIndex(idx);
    return { status: 'skipped', reason: 'no human prompts' };
  }

  const route = routeFor(cfg, s.cwd);
  const llm = await pickBackend(cfg, route.backend);
  log(`${harness} ${s.sessionId} → ${route.kind} vault via ${llm.label}`);

  const hdr = header(s);
  const parts = chunks(s, llm.chunkChars);
  let body;
  if (parts.length === 1) body = parts[0];
  else {
    const notes = [];
    for (const [i, p] of parts.entries()) {
      log(`  part ${i + 1}/${parts.length}`);
      notes.push(`### Part ${i + 1}\n${await llm.complete(SYSTEM, chunkPrompt(hdr, p, i + 1, parts.length))}`);
    }
    const promptList = s.turns.map((t, i) => `${i + 1}. ${redact(t.prompt).replace(/\s+/g, ' ').slice(0, 300)}`);
    body = `All prompts, in order:\n${promptList.join('\n')}\n\nNotes on each part:\n\n${notes.join('\n\n')}`;
  }
  const answer = parseAnswer(await llm.complete(SYSTEM, finalPrompt(hdr, body)));
  answer.title ||= s.title || s.turns[0].prompt.replace(/\s+/g, ' ').slice(0, 60);

  const dir = path.join(route.vault, route.folder, (s.start || new Date()).toISOString().slice(0, 7));
  const project = path.basename(s.cwd || '') || 'unknown';
  const date = (s.start || new Date()).toLocaleString('sv-SE').slice(0, 10);
  const note =
    prev?.note && fs.existsSync(prev.note)
      ? prev.note
      : path.join(dir, `${date} ${s.harness} ${safe(project)} - ${safe(answer.title)}.md`);
  fs.mkdirSync(path.dirname(note), { recursive: true });
  const text = redact(render(s, answer, llm.label, readMyNotes(note)));
  fs.writeFileSync(note, text);

  idx[key] = { note, mtimeMs: st.mtimeMs, sessionId: s.sessionId, at: new Date().toISOString(), kind: route.kind };
  saveIndex(idx);
  return { status: 'written', note, kind: route.kind, backend: llm.label, title: answer.title };
}
