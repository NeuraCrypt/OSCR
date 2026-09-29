// The editor's warning before a commit that may carry a secret (night phase 03, E2; the inventory's
// "Push protection in web editing and uploads"): the shapes of the tokens and keys most often
// leaked in research code, found in the text the commit would write, said by kind and line with
// the value hidden. GitHub's own push protection may still block the commit (it covers web commits
// on public repositories, D00-11); this warns before, in the registry, and the person decides.
// Phase 11 (security and quality) brings its report's full list; this is the same idea, small.
// Pure, testable in Node (tests/forge-pages/secrets.test.ts); nothing found is ever sent anywhere.

export interface SecretFinding {
  /** What it looks like: "a GitHub token". */
  kind: string;
  /** 1-based. */
  line: number;
  /** The value's first characters, the rest hidden: enough to find it, never enough to use it. */
  hint: string;
}

/** Token shapes with a prefix or a structure of their own (few false alarms by design). */
const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { kind: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "a private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "a Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g },
  { kind: "a Stripe live key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { kind: "an OpenAI key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g },
  { kind: "an Anthropic key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b/g },
  { kind: "a Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "an npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "a PyPI token", re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g },
  { kind: "a SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { kind: "a Twilio key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: "a Discord webhook", re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/g },
  { kind: "a password in an address", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"']{1,64}:[^\s@/"']{3,128}@[A-Za-z0-9.-]+/g },
];

/** Texts larger than this are scanned in their first part only (the editor's own limit is 1 MiB). */
export const SCAN_CHARS = 2_000_000;
/** Findings reported at most. */
export const SCAN_FINDINGS = 50;

const hide = (value: string): string => `${value.slice(0, Math.min(6, Math.floor(value.length / 4)))}…`;

/** The secrets a text seems to hold, by line. */
export function findSecrets(text: string): SecretFinding[] {
  const t = text.length > SCAN_CHARS ? text.slice(0, SCAN_CHARS) : text;
  const out: SecretFinding[] = [];
  const starts: number[] = [0];
  for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const { kind, re } of PATTERNS) {
    for (const m of t.matchAll(re)) {
      // Documentation's own placeholders ("ghp_XXXX…", "AKIAIOSFODNN7EXAMPLE") are not secrets.
      if (/EXAMPLE|X{8,}|x{8,}|0{12,}|\*{4,}/.test(m[0])) continue;
      out.push({ kind, line: lineAt(m.index!), hint: hide(m[0]) });
      if (out.length >= SCAN_FINDINGS) return out.sort((a, b) => a.line - b.line);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The findings in words, one sentence each: "Line 12 of config.py: a GitHub token (ghp_ab…)". */
export function secretsInWords(path: string, findings: readonly SecretFinding[]): string[] {
  return findings.map((f) => `Line ${f.line} of ${path}: ${f.kind} (${f.hint}).`);
}
