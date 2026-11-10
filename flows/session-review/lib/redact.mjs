// Mask things that look like credentials before text goes to a model or into a note.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[REDACTED]@'],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key)[A-Za-z0-9_]*)(\s*[=:]\s*["']?)([^\s"']{8,})/gi,
    '$1$2[REDACTED]',
  ],
];

export function redact(text) {
  let t = String(text ?? '');
  for (const [re, sub] of RULES) t = t.replace(re, sub);
  return t;
}
