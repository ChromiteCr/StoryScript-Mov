#!/usr/bin/env node
/**
 * Production-dependency license gate (CLEANROOM §4). Plain Node, no deps.
 *
 *   node scripts/check-licenses.mjs      (npm run licenses)
 *
 * - tree: `npm ls --omit=dev --all --json --long` (argument array, no shell;
 *   --long only adds each package's install path)
 * - license: read from each package.json (SPDX expression, legacy
 *   `license: {type}` object or `licenses: [...]` array)
 * - GPL / AGPL / LGPL / SSPL / unknown → exit 1 with a list; MPL-2.0 is
 *   allowed but called out
 * - writes THIRD_PARTY_NOTICES.md at the repo root (sorted, no timestamps)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOW = new Set(
  [
    'MIT',
    'MIT-0',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Apache-2.0',
    'CC0-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'Unlicense',
    'BlueOak-1.0.0',
    'Python-2.0',
    'Zlib',
    'BSL-1.0',
  ].map((s) => s.toLowerCase()),
);
const FLAG = new Set(['mpl-2.0']);
const DENY = /^(a|l)?gpl(-|$)|^sspl(-|$)/i;

// severity: allow < flag < unknown < deny
const RANK = { allow: 0, flag: 1, unknown: 2, deny: 3 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

function classifyId(id) {
  const base = id.replace(/\+$/, '');
  if (DENY.test(base)) return 'deny';
  const k = base.toLowerCase();
  if (FLAG.has(k)) return 'flag';
  if (ALLOW.has(k)) return 'allow';
  return 'unknown';
}

/** Minimal SPDX expression evaluator: OR picks the best option, AND the worst. */
export function classifyExpression(expr) {
  const tokens = expr.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  function atom() {
    const t = tokens[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const v = orExpr();
      if (tokens[i++] !== ')') throw new Error('missing )');
      return v;
    }
    if (/^(and|or|with|\))$/i.test(t)) throw new Error(`unexpected ${t}`);
    const v = classifyId(t);
    if (peek()?.toUpperCase() === 'WITH') {
      i++;
      if (tokens[i++] === undefined) throw new Error('missing exception');
      // exceptions only add permissions; the base license decides
    }
    return v;
  }
  function andExpr() {
    let v = atom();
    while (peek()?.toUpperCase() === 'AND') {
      i++;
      v = worst(v, atom());
    }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      i++;
      v = best(v, andExpr());
    }
    return v;
  }
  try {
    const v = orExpr();
    return i === tokens.length ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** License string as declared (for the notices) + its verdict. */
export function readLicense(pkg) {
  let text = null;
  if (typeof pkg.license === 'string') text = pkg.license.trim();
  else if (pkg.license && typeof pkg.license.type === 'string') text = pkg.license.type.trim();
  else if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string');
    if (types.length) text = types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  if (!text || /^unlicensed$/i.test(text) || /^see licen[cs]e in /i.test(text)) {
    return { license: text ?? '(missing)', verdict: 'unknown' };
  }
  return { license: text, verdict: classifyExpression(text) };
}

export function repoUrl(pkg) {
  let r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (typeof r !== 'string' || !r.trim()) return typeof pkg.homepage === 'string' ? pkg.homepage : '';
  r = r.trim();
  const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
  let m = r.match(/^(github|gitlab|bitbucket):(.+)$/);
  if (m) return `https://${host[m[1]]}/${m[2].replace(/\.git$/, '')}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r.replace(/\.git$/, '')}`;
  m = r.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return r
    .replace(/^git\+/, '')
    .replace(/^(git|ssh):\/\/(git@)?/, 'https://')
    .replace(/^https:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
}

function npmLs() {
  const args = ['ls', '--omit=dev', '--all', '--json', '--long'];
  // prefer the npm that runs us (npm run licenses) — works without a shell on every OS
  const cli = process.env.npm_execpath;
  const [bin, argv] = cli && /\.c?js$/.test(cli) ? [process.execPath, [cli, ...args]] : ['npm', args];
  const r = spawnSync(bin, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: false });
  if (r.error) throw r.error;
  // npm ls exits non-zero on tree problems but still prints JSON
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm ls failed (${r.status}): ${r.stderr.slice(0, 2000)}`);
  }
}

/** Walk the tree → Map<name@version, {name, version, path, users:Set}> (first-party workspaces excluded). */
export function collect(tree) {
  // workspace packages resolve to file:…; deduped references to them carry only a version
  const firstPartyNames = new Set();
  const scan = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (typeof dep?.resolved === 'string' && dep.resolved.startsWith('file:')) firstPartyNames.add(name);
      if (dep) scan(dep);
    }
  };
  scan(tree);

  const out = new Map();
  const walk = (node, user) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!dep || !dep.version) continue; // uninstalled optional peer
      const firstParty = firstPartyNames.has(name);
      const nextUser = user ?? (firstParty ? name : null);
      if (!firstParty) {
        const key = `${name}@${dep.version}`;
        const e = out.get(key) ?? { name, version: dep.version, path: null, users: new Set() };
        if (!e.path && dep.path) e.path = dep.path;
        if (nextUser) e.users.add(nextUser);
        out.set(key, e);
      }
      walk(dep, nextUser);
    }
  };
  walk(tree, null);
  return out;
}

function main() {
  const tree = npmLs();
  const pkgs = [...collect(tree).values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );

  const rows = [];
  const bad = [];
  const flagged = [];
  for (const p of pkgs) {
    let meta = {};
    if (p.path) {
      try {
        meta = JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8'));
      } catch {
        meta = {};
      }
    }
    const { license, verdict } = p.path ? readLicense(meta) : { license: '(not installed)', verdict: 'unknown' };
    const row = { ...p, license, verdict, repo: repoUrl(meta) };
    rows.push(row);
    if (verdict === 'deny' || verdict === 'unknown') bad.push(row);
    if (verdict === 'flag') flagged.push(row);
  }

  // contracts/core are inlined into both the server dist and the web bundle
  const WHERE = { 'storyscript-mov': ['server'], '@storyscript/web': ['web'] };
  const users = (r) => [...new Set([...r.users].flatMap((u) => WHERE[u] ?? ['server', 'web']))].sort();
  const md = [
    '# Third-party notices',
    '',
    '由 `npm run licenses`（scripts/check-licenses.mjs）根据生产依赖树自动生成，请勿手改。',
    '"使用方"一列：server = 随 `storyscript-mov` 安装的运行时依赖；web = 打包进前端产物的依赖。',
    '',
    '| 名称 | 版本 | 许可 | 使用方 | 仓库 |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${users(r).join(', ')} | ${r.repo || '—'} |`),
    '',
    '## 说明',
    '',
    ...flagged.map(
      (r) => `- \`${r.name}\`（${r.license}）：作为外部依赖原样安装，未修改、未打包进本项目产物；源码见 ${r.repo || '其 npm 包'}。`,
    ),
    '- ffmpeg / ffprobe 不随本项目分发，由用户自行安装，本项目只以子进程方式调用。',
    '',
  ].join('\n');
  writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), md);

  console.log(`生产依赖 ${rows.length} 个（不含本仓库 workspace 包），已写入 THIRD_PARTY_NOTICES.md`);
  for (const r of flagged) console.log(`  注意 ${r.name}@${r.version}: ${r.license}（允许，已在 NOTICES 标注）`);
  if (bad.length) {
    console.error(`许可证检查失败：${bad.length} 个生产依赖为 GPL/AGPL/LGPL/SSPL 或未知许可`);
    for (const r of bad) console.error(`  ${r.name}@${r.version}: ${r.license} [${r.verdict}]`);
    process.exit(1);
  }
  console.log('许可证检查通过');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
