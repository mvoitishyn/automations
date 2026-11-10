// Backends, by type:
//   openai  any OpenAI-compatible server (e.g. vLLM on a GPU box)
//   ollama  an Ollama server (on a GPU box or this machine)
//   claude  headless Claude Code (for projects you allow to use a cloud model)
// A route lists backends in order of preference; the first one that answers a health check is used.
// Sensitive routes should list only self-hosted backends, so they can never fall through to a cloud model.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { expand, STATE_DIR } from './config.mjs';

// Keys are read at call time from where they already live (pi's models.json), never copied.
function apiKey(b) {
  if (b.apiKeyEnv) return process.env[b.apiKeyEnv];
  if (b.apiKeyFromPi) {
    const file = expand(process.env.PI_CODING_AGENT_DIR ? `${process.env.PI_CODING_AGENT_DIR}/models.json` : '~/.pi/agent/models.json');
    const k = JSON.parse(fs.readFileSync(file, 'utf8')).providers?.[b.apiKeyFromPi]?.apiKey;
    return k?.startsWith('$') ? process.env[k.slice(1)] : k;
  }
  return undefined;
}

const authHeaders = (b) => {
  const k = apiKey(b);
  return k ? { authorization: `Bearer ${k}` } : {};
};

const stripThink = (t) => (t ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function openai(b, system, prompt) {
  const res = await fetch(`${b.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(b) },
    body: JSON.stringify({
      model: b.model,
      temperature: 0.3,
      max_tokens: b.maxTokens || 4096,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) throw new Error(`${b.url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return stripThink((await res.json()).choices?.[0]?.message?.content);
}

async function ollama(b, system, prompt) {
  const res = await fetch(`${b.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(b) },
    body: JSON.stringify({
      model: b.model,
      stream: false,
      think: false,
      keep_alive: '2m',
      options: { num_ctx: b.numCtx, temperature: 0.3 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(20 * 60_000),
  });
  if (!res.ok) throw new Error(`${b.url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return stripThink((await res.json()).message?.content);
}

function claude(b, system, prompt) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const args = [
    '-p',
    '--model',
    b.model,
    '--no-session-persistence', // the review itself must not become a session to review
    '--setting-sources',
    '', // no user/project settings: no hooks, no plugins
    '--strict-mcp-config',
    '--tools',
    '',
    '--system-prompt',
    system,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, {
      cwd: STATE_DIR,
      env: { ...process.env, SESSION_REVIEW_CHILD: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), 15 * 60_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
    });
    p.stdin.end(prompt);
  });
}

const CALL = { openai, ollama, claude };

// Is the server up and serving this model? (Claude is assumed available.)
export async function healthy(b) {
  if (b.type === 'claude') return true;
  try {
    const url = b.type === 'ollama' ? `${b.url}/api/tags` : `${b.url}/models`;
    const res = await fetch(url, { headers: authHeaders(b), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const j = await res.json();
    const ids = b.type === 'ollama' ? j.models?.map((m) => m.name) : j.data?.map((m) => m.id);
    return !!ids?.includes(b.model);
  } catch {
    return false;
  }
}

function make(name, b) {
  return {
    name,
    label: `${name}:${b.model}`,
    chunkChars: b.chunkChars,
    complete: (system, prompt) => CALL[b.type](b, system, prompt),
  };
}

// First healthy backend from the route's list.
export async function pickBackend(cfg, names) {
  const list = [].concat(names);
  const down = [];
  for (const n of list) {
    const b = cfg.backends[n];
    if (!b) throw new Error(`unknown backend "${n}" in config`);
    if (await healthy(b)) return make(n, b);
    down.push(n);
  }
  throw new Error(`no backend available (tried ${down.join(', ')})`);
}
