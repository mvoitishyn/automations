// Condense a parsed session into plain text a model can read: every human prompt in full
// (capped), what the agent did after it (one line per tool call, errors and rejections marked),
// and the agent's last reply in that turn. Thinking blocks and raw tool output are left out.
import path from 'node:path';
import { redact } from './redact.mjs';

const cap = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) + `\n…[${t.length - n} more chars]` : t;
};

const hhmm = (ts) => (ts ? new Date(ts).toTimeString().slice(0, 5) : '--:--');

export function header(s) {
  const mins = s.start && s.end ? Math.round((s.end - s.start) / 60000) : 0;
  return [
    `Harness: ${s.harness}`,
    `Project: ${path.basename(s.cwd || '')} (${s.cwd})`,
    `When: ${s.start?.toISOString().slice(0, 16).replace('T', ' ')} for ${mins} min`,
    `Models: ${s.models.join(', ') || 'unknown'}`,
    `Prompts: ${s.prompts}, tool calls: ${s.toolCalls}, tool errors: ${s.toolErrors}, ` +
      `rejected tool calls: ${s.rejections}, interrupts: ${s.interrupts}, compactions: ${s.compactions}`,
  ].join('\n');
}

export function turnText(t, i) {
  const lines = [`### Prompt ${i + 1} (${hhmm(t.at)})${t.interrupted ? ' [user interrupted the agent]' : ''}`];
  lines.push(cap(t.prompt, 2500), '');
  if (t.actions.length) {
    lines.push(`Agent actions (${t.actions.length}):`);
    // Long runs of tool calls: keep the start, the end, and every failure.
    const keep = new Set();
    t.actions.forEach((a, j) => {
      if (j < 15 || j >= t.actions.length - 10 || a.error || a.rejected) keep.add(j);
    });
    let skipped = 0;
    t.actions.forEach((a, j) => {
      if (!keep.has(j)) return void skipped++;
      if (skipped) lines.push(`- … ${skipped} more calls`), (skipped = 0);
      let l = `- ${a.tool}: ${a.detail}`;
      if (a.error) l += `\n  ✗ ERROR: ${a.error}`;
      if (a.rejected) l += `\n  ⛔ REJECTED: ${a.rejected}`;
      lines.push(l);
    });
    if (skipped) lines.push(`- … ${skipped} more calls`);
    lines.push('');
  }
  if (t.reply) lines.push('Agent reply:', cap(t.reply, 2000), '');
  return lines.join('\n');
}

// Split the turns into chunks of at most `maxChars` (a single huge turn becomes its own chunk).
export function chunks(s, maxChars) {
  const out = [];
  let cur = '';
  s.turns.forEach((t, i) => {
    const txt = redact(turnText(t, i));
    if (cur && cur.length + txt.length > maxChars) out.push(cur), (cur = '');
    cur += txt + '\n';
  });
  if (cur) out.push(cur.length > maxChars ? cur.slice(0, maxChars) + '\n…[truncated]' : cur);
  return out;
}

export const SYSTEM = `You review a coding-agent session for the developer who ran it, so they can learn from it later.
Be concrete and specific to this session: name files, commands, decisions and mistakes. No generic advice.
Judge both sides honestly: the agent (wrong assumptions, wasted steps, errors, ignored instructions)
and the developer's prompting (unclear asks, missing context, typos that caused misreads, good moves).
If something did not happen, write "None." rather than inventing it.`;

export const FORMAT = `Answer in exactly this Markdown format, nothing before or after:

TITLE: <5-9 word title of what this session was about>
OUTCOME: <one of: done, partial, abandoned, exploratory>
TAGS: <3-6 lowercase tags, comma separated>

## Summary
<2-4 sentences: what was asked, what got done>

## What went well
- <bullets>

## What went wrong
- <bullets: errors, dead ends, wrong assumptions, wasted effort, and why>

## Friction and corrections
- <bullets: each place the developer had to correct, repeat, or redirect the agent, quoting the prompt briefly>

## Prompting lessons
- <bullets: how the developer could have asked better, or what worked well in their prompts>

## Agent lessons
- <bullets: rules the agent should follow next time; good candidates for CLAUDE.md / AGENTS.md>

## Follow-ups
- [ ] <open tasks left at the end of the session>`;

export const chunkPrompt = (hdr, part, n, total) =>
  `${hdr}

This is part ${n} of ${total} of the session log. Write compact notes on this part only (max 300 words):
what the developer asked, what the agent did, what worked, what failed or was corrected (quote briefly).

${part}`;

export const finalPrompt = (hdr, body) => `${hdr}

Session log:

${body}

${FORMAT}`;
