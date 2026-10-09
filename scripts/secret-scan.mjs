import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFlagIndex = process.argv.indexOf('--root');
if (rootFlagIndex >= 0 && !process.argv[rootFlagIndex + 1]) {
  throw new Error('--root requires a directory path');
}
const root = rootFlagIndex >= 0 ? path.resolve(process.argv[rootFlagIndex + 1]) : defaultRoot;
const excludedDirs = new Set(['.git', 'node_modules', '.wrangler', '.wrangler-dry-run', 'release']);
const excludedFiles = new Set(['SHA256SUMS', 'secret-scan.mjs']);
const textExtensions = new Set([
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.ps1',
  '.env',
  '.example',
  '.gitignore',
  '.editorconfig',
]);

const patterns = [
  ['OpenAI-style key', new RegExp('s' + 'k-[A-Za-z0-9_-]{20,}', 'g')],
  ['GitHub token', new RegExp('g' + 'h[posur]_[A-Za-z0-9]{20,}', 'g')],
  ['GitHub fine-grained PAT', new RegExp('g' + 'ithub_pat_[A-Za-z0-9_]{22,}', 'g')],
  ['Google API key', new RegExp('A' + 'Iza[A-Za-z0-9_-]{20,}', 'g')],
  ['Google OAuth client secret', new RegExp('G' + 'OCSPX-[A-Za-z0-9_-]{20,}', 'g')],
  ['Private key', /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/g],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*=\s*["']?[A-Za-z0-9_-]{30,}/g],
  ['AWS access key ID', /\bAKIA[0-9A-Z]{16}\b/g],
  ['npm token', new RegExp('n' + 'pm_[A-Za-z0-9]{36}', 'g')],
  ['Slack token', new RegExp('x' + 'ox[baprs]-[A-Za-z0-9-]{10,}', 'g')],
];

// SHA-256 digests of values that are public by design and documented in
// SECURITY.md "Google OAuth client constants" (the Gemini CLI's installed-app
// OAuth client). Allowlisting the digest — never the plaintext — keeps this
// script free of credential values while still failing on any other match of
// the same pattern family.
//
// ▚ HUMAN DECISION REQUIRED: confirm the client type in the Google Cloud
// Console. If it is a "Desktop app / Installed application", the digest stays
// and the constant remains documented. If it is a "Web application", rotate
// the secret immediately, move the value into a Worker secret, delete the
// constant from src/providers/google.ts, and remove this digest entry.
const knownPublicValueDigests = new Set([
  // Gemini CLI installed-app OAuth client secret
  '6a5f78b8b99dd4025e41ba11bf54c304c6af29f924c5569cc7865b2428ce03a9',
]);

function matchIsAllowlisted(match) {
  const digest = createHash('sha256').update(match, 'utf8').digest('hex');
  return knownPublicValueDigests.has(digest);
}

const sensitiveNames = [/^\.dev\.vars$/, /^\.env(?:\..+)?$/, /^secrets.*\.json$/i, /^wrangler\.user\.jsonc$/, /^gateway-.*-secrets.*\.json$/i];
const findings = [];

function scanFile(rel) {
  const normalized = rel.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.slice(0, -1).some((part) => excludedDirs.has(part))) return;
  const name = parts.at(-1);
  if (!name || excludedFiles.has(name) || name.startsWith('.wrangler-local-')) return;
  if (sensitiveNames.some((pattern) => pattern.test(name)) && !name.endsWith('.example')) {
    findings.push(`${normalized}: sensitive file must not be committed`);
    return;
  }
  const ext = path.extname(name);
  if (!textExtensions.has(ext) && !name.startsWith('.')) return;
  let content;
  try {
    content = fs.readFileSync(path.join(root, normalized), 'utf8');
  } catch {
    return;
  }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (matchIsAllowlisted(match[0])) continue;
      findings.push(`${normalized}: possible ${label}`);
      break;
    }
  }
}

// In a working tree, scan exactly what could enter a commit: tracked files plus
// untracked files not excluded by .gitignore. Local deployment material such
// as wrangler.user.jsonc remains on disk by design and must not make every
// post-configuration `npm run validate:merge` fail. A forcibly tracked sensitive file
// is still returned by `git ls-files --cached` and is therefore rejected.
// Source archives may not contain .git; fall back to the conservative walk in
// that case so release artifacts still receive a useful scan.
let gitCandidates = null;
try {
  gitCandidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean);
} catch {
  /* archive / environment without git */
}

if (gitCandidates) {
  for (const rel of gitCandidates) scanFile(rel);
} else {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else scanFile(path.relative(root, full));
    }
  };
  walk(root);
}
if (findings.length) {
  console.error('Potential secrets detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');
