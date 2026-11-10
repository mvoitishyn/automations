// Config lives outside the repo, in ~/.config/automations/session-review.json, so vault paths,
// server addresses and routing never end up in git. Start from session-review.example.json.
// Routes are matched by the session's working directory; the first matching prefix wins.
// Anything unmatched uses `default`, which out of the box is a model on this machine:
// a session nobody classified never leaves the computer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
export const CONFIG_DIR = path.join(XDG_CONFIG, 'automations');
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'session-review');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'session-review.json');

export const DEFAULT_CONFIG = {
  routes: [],
  default: { kind: 'default', vault: null, folder: 'sessions', backend: ['local-ollama'] },
  backends: {
    'local-ollama': {
      type: 'ollama',
      url: 'http://127.0.0.1:11434',
      model: 'qwen3:4b-instruct-2507-q4_K_M',
      numCtx: 16384,
      chunkChars: 30000,
    },
    claude: { type: 'claude', model: 'sonnet', chunkChars: 300000 },
  },
  // Skip sessions where nothing really happened.
  minPrompts: 1,
  // Sweep only sessions untouched for this long (they may still be open otherwise).
  settleMinutes: 20,
  sweepDays: 3,
  notify: true,
};

export const expand = (p) => (p?.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Bad config ${CONFIG_FILE}: ${err.message}`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.backends = { ...DEFAULT_CONFIG.backends, ...user.backends };
  for (const k of Object.keys(cfg.backends))
    cfg.backends[k] = { ...DEFAULT_CONFIG.backends[k], ...user.backends?.[k] };
  return cfg;
}

export function routeFor(cfg, cwd) {
  const dir = path.resolve(cwd || '/') + '/';
  const hit = cfg.routes.find((r) => dir.startsWith(expand(r.match).replace(/\/?$/, '/')) || dir === expand(r.match));
  const r = { ...(hit || cfg.default) };
  if (!r.vault) throw new Error(`no vault configured for ${cwd}: set "vault" in ${CONFIG_FILE}`);
  r.vault = expand(r.vault);
  return r;
}
