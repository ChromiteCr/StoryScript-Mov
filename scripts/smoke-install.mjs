#!/usr/bin/env node
/**
 * Install-path smoke test (SPEC §7: both install paths work under a temporary
 * HOME). Plain Node, no dependencies, no shell: every command is spawned with
 * an argument array.
 *
 *   node scripts/smoke-install.mjs [--skip-build] [--only pack|source]
 *                                  [--cache <dir>] [--report <file>] [--keep]
 *
 * a. packed package: npm run build → npm pack (apps/server) → file-list policy
 *    (only dist/, web/, package.json, README.md, LICENSE, THIRD_PARTY_NOTICES.md;
 *    no tests, sources, source maps, .env or fixtures) → with a fresh HOME and
 *    npm cache: `npx <tgz> doctor` exits 0 → `npx <tgz> start --no-open --port
 *    <free>` → runtime.json (0600) → GET / is index.html (+ its script) → the
 *    token buys a cookie → /api/v1/health 200 → SIGINT → runtime.json removed.
 * b. from source: git clone file://<repo> (the committed HEAD; uncommitted
 *    changes are not part of it) → npm ci → npm start (builds the web app,
 *    then tsx) → the same checks.
 *
 * --cache reuses an npm cache (faster; default: a fresh one per run, shared by
 * both paths). The registry of the calling user's npm config is kept, nothing
 * else of their HOME is visible. Exit code 0 = both paths passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_DIR = join(ROOT, 'apps', 'server');
const STATE_REL = ['.config', 'storyscript-mov'];

const log = (...a) => console.log('[smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** For Promise.race deadlines: does not keep the process alive once the race is decided. */
const deadline = (ms) => new Promise((r) => setTimeout(r, ms).unref());

class SmokeError extends Error {}
const fail = (msg) => {
  throw new SmokeError(msg);
};
const check = (ok, msg) => {
  if (!ok) fail(msg);
};

// ---------------------------------------------------------------------------
// package contents policy
// ---------------------------------------------------------------------------

const TOP_LEVEL = new Set(['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);

/** `--demo` inputs (scripts/demo-data.mjs): the sample script, its replay recordings, the demo footage. */
const DEMO_FILE = /^demo-data\/(fixtures\/scripts\/[^/]+\.txt|fixtures\/replay\/[^/]+\.json|samples\/demo-media\/(media\.json|posters\/[^/]+\.jpg|clips\/[^/]+\.(mov|mp4|txt)))$/;

/** Problems with an `npm pack` file list (paths relative to the package root). */
export function packProblems(files) {
  const problems = [];
  for (const f of files) {
    const top = f.split('/')[0];
    if (top === 'demo-data') {
      if (!DEMO_FILE.test(f)) problems.push(`demo-data 里不应有：${f}`);
      continue;
    }
    if (!TOP_LEVEL.has(f) && top !== 'dist' && top !== 'web') problems.push(`不应打包：${f}`);
    if (/\.map$/i.test(f)) problems.push(`不应打包 source map：${f}`);
    if (/(^|\/)\.env(\.|$)/i.test(f)) problems.push(`不应打包 .env：${f}`);
    if (/(^|\/)(src|test|tests|__tests__|fixtures|e2e)\//i.test(f)) problems.push(`不应打包源码、测试或样例：${f}`);
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(f)) problems.push(`不应打包测试：${f}`);
    if (/\.[cm]?tsx?$/i.test(f) && !/\.d\.[cm]?ts$/i.test(f)) problems.push(`不应打包 TypeScript 源码：${f}`);
    if (/(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(f) || /\.(tgz|log|sqlite)$/i.test(f)) problems.push(`不应打包杂项文件：${f}`);
  }
  for (const need of ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs', 'web/index.html', 'demo-data/fixtures/scripts/01-bookshop.txt', 'demo-data/samples/demo-media/media.json']) {
    if (!files.includes(need)) problems.push(`缺少 ${need}`);
  }
  if (!files.includes('THIRD_PARTY_NOTICES.md') && !files.includes('dist/THIRD_PARTY_NOTICES.md')) problems.push('缺少 THIRD_PARTY_NOTICES.md');
  if (!files.some((f) => /^web\/assets\/[^/]+\.js$/.test(f))) problems.push('web/assets 下没有前端脚本');
  return problems;
}

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------

/** The caller's environment minus npm/vitest/app leftovers; HOME and the npm cache are replaced. */
function isolatedEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const K = k.toUpperCase();
    if (K.startsWith('NPM_') || K.startsWith('STORYSCRIPT_') || K.startsWith('VITEST') || K.startsWith('TINYPOOL')) continue;
    if (['NODE_ENV', 'NODE_OPTIONS', 'INIT_CWD', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEST'].includes(K)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function tail(text, n = 60) {
  return text.split('\n').slice(-n).join('\n');
}

/** Run to completion; resolves {code, out, stdout} (out = stdout+stderr interleaved, for messages). */
function run(cmd, args, { cwd, env, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '';
    let stdout = '';
    const onData = (d) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      onData(d);
    });
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      out += `\n[smoke] 超时（${Math.round(timeoutMs / 1000)} 秒），已终止`;
      signalTree(child, 'SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, out: `${out}\n${err.message}`, stdout });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? (signal ? 128 : -1), out, stdout });
    });
  });
}

async function mustRun(label, cmd, args, opts) {
  const t0 = Date.now();
  log(`${label}：${cmd} ${args.join(' ')}`);
  const r = await run(cmd, args, opts);
  if (r.code !== 0) fail(`${label} 失败（退出码 ${r.code}）\n${tail(r.out)}`);
  log(`${label} 完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  return r;
}

/** Like Ctrl+C in a terminal: the whole process group (npx/npm → sh → node) gets the signal. */
function signalTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function freePort() {
  return new Promise((ok, no) => {
    const srv = createServer();
    srv.once('error', no);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => ok(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, no) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(30_000, () => r.destroy(new Error(`请求超时：${method} ${path}`)));
    r.on('error', no);
    r.end(body);
  });
}

// ---------------------------------------------------------------------------
// a running server
// ---------------------------------------------------------------------------

/** Start a server command, verify it end to end, stop it with SIGINT, verify cleanup. */
async function exerciseServer(label, cmd, args, { cwd, env, home, port, bootMs, demo = false }) {
  const stateDir = join(home, ...STATE_REL);
  const rtFile = join(stateDir, 'runtime.json');
  log(`${label}：${cmd} ${args.join(' ')}`);
  const t0 = Date.now();
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  let exited = false;
  const exit = new Promise((r) => child.on('close', (code, signal) => ((exited = true), r({ code, signal }))));

  try {
    let rt = null;
    while (!rt) {
      if (exited) fail(`${label}：服务提前退出\n${tail(out)}`);
      if (Date.now() - t0 > bootMs) fail(`${label}：${Math.round(bootMs / 1000)} 秒内没有写出 ${rtFile}\n${tail(out)}`);
      try {
        const parsed = JSON.parse(readFileSync(rtFile, 'utf8'));
        if (parsed.port === port && typeof parsed.token === 'string') rt = parsed;
      } catch {
        // not yet
      }
      if (!rt) await sleep(200);
    }
    const bootSeconds = (Date.now() - t0) / 1000;
    if (process.platform !== 'win32') {
      const mode = statSync(rtFile).mode & 0o777;
      check(mode === 0o600, `${label}：runtime.json 权限应为 0600，实际 ${mode.toString(8)}`);
    }
    check(rt.token.length >= 32, `${label}：令牌过短`);
    check(out.includes(`http://127.0.0.1:${port}/#t=`), `${label}：终端没有打印带令牌的打开链接\n${tail(out)}`);

    const host = `127.0.0.1:${port}`;
    const page = await http(port, '/', { headers: { host } });
    check(page.status === 200, `${label}：GET / 返回 ${page.status}`);
    check(page.body.includes('<div id="root"'), `${label}：GET / 不是前端 index.html\n${page.body.slice(0, 300)}`);
    check(String(page.headers['content-security-policy'] ?? '').includes("default-src 'self'"), `${label}：GET / 缺少 CSP`);
    const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    check(Boolean(script), `${label}：index.html 没有引用 /assets/*.js`);
    const asset = await http(port, script, { headers: { host } });
    check(asset.status === 200 && /javascript/.test(String(asset.headers['content-type'])), `${label}：${script} 返回 ${asset.status}`);

    const anonymous = await http(port, '/api/v1/health', { headers: { host } });
    check(anonymous.status === 401, `${label}：无 cookie 的 /api/v1/health 应为 401，实际 ${anonymous.status}`);
    const rebinding = await http(port, '/api/v1/health', { headers: { host: `evil.example:${port}` } });
    check(rebinding.status === 403, `${label}：伪造 Host 应为 403，实际 ${rebinding.status}`);
    const ex = await http(port, '/api/v1/session', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: rt.token }),
    });
    check(ex.status === 204, `${label}：令牌换 cookie 返回 ${ex.status} ${ex.body}`);
    const cookie = String(ex.headers['set-cookie'] ?? '').split(';')[0];
    check(/^ssm_session=.+/.test(cookie), `${label}：没有拿到会话 cookie`);
    const health = await http(port, '/api/v1/health', { headers: { host, cookie } });
    check(health.status === 200, `${label}：带 cookie 的 /api/v1/health 返回 ${health.status} ${health.body}`);
    const data = JSON.parse(health.body).data;
    check(typeof data?.app_version === 'string' && typeof data?.sqlite === 'string', `${label}：health 内容不对：${health.body}`);
    if (demo) {
      // the packaged demo-data is found and seeded: shots, and the six demo clips with posters
      check(data.demo === true, `${label}：health 没有标出演示模式：${health.body}`);
      const list = async (path) => {
        const r = await http(port, path, { headers: { host, cookie } });
        return r.status === 200 ? JSON.parse(r.body).data.length : `HTTP ${r.status} ${r.body.slice(0, 200)}`;
      };
      const shots = await list('/api/v1/shots');
      check(typeof shots === 'number' && shots >= 10, `${label}：演示项目的镜头数不对：${shots}`);
      const clips = await list('/api/v1/media/assets');
      check(clips === 6, `${label}：演示素材应为 6 条，实际 ${clips}`);
    }

    signalTree(child, 'SIGINT');
    const stopped = await Promise.race([exit, deadline(30_000).then(() => null)]);
    if (!stopped) {
      signalTree(child, 'SIGKILL');
      fail(`${label}：SIGINT 后 30 秒仍未退出\n${tail(out)}`);
    }
    // npm/npx may exit before the server finished closing
    for (let i = 0; i < 50 && (existsSync(rtFile) || pidAlive(rt.pid)); i++) await sleep(200);
    check(!pidAlive(rt.pid), `${label}：服务进程 ${rt.pid} 在 SIGINT 后仍在运行`);
    check(!existsSync(rtFile), `${label}：退出后 runtime.json 没有被清理\n${tail(out)}`);
    log(`${label} 通过：启动 ${bootSeconds.toFixed(1)} 秒，app ${data.app_version}，Node ${data.node}，SQLite ${data.sqlite}`);
    return { port, boot_seconds: bootSeconds, app_version: data.app_version, node: data.node, sqlite: data.sqlite, ffmpeg: data.ffmpeg?.path ?? null, runtime_cleaned: true };
  } finally {
    if (!exited) {
      signalTree(child, 'SIGKILL');
      await Promise.race([exit, deadline(5_000)]);
    }
  }
}

// ---------------------------------------------------------------------------
// the two paths
// ---------------------------------------------------------------------------

function userRegistry() {
  const r = spawnSync('npm', ['config', 'get', 'registry'], { cwd: tmpdir(), encoding: 'utf8', env: isolatedEnv({}) });
  const url = r.status === 0 ? r.stdout.trim() : '';
  return /^https?:\/\//.test(url) ? url : 'https://registry.npmjs.org/';
}

function envFor(home, cache, registry) {
  mkdirSync(home, { recursive: true });
  return isolatedEnv({
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_registry: registry,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'warn',
  });
}

async function packPath({ tmp, cache, registry, skipBuild }) {
  if (!skipBuild) await mustRun('构建（npm run build）', 'npm', ['run', 'build'], { cwd: ROOT, env: isolatedEnv({}), timeoutMs: 10 * 60_000 });
  check(existsSync(join(SERVER_DIR, 'dist', 'cli.mjs')), 'apps/server/dist/cli.mjs 不存在：请先 npm run build（或去掉 --skip-build）');

  const packDir = join(tmp, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packed = await mustRun('打包（npm pack）', 'npm', ['pack', '--json', '--pack-destination', packDir], { cwd: SERVER_DIR, env: isolatedEnv({}) });
  const json = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
  const info = json[0];
  const files = info.files.map((f) => f.path).sort();
  const problems = packProblems(files);
  check(problems.length === 0, `发布包内容不合规：\n  ${problems.join('\n  ')}\n文件列表：\n  ${files.join('\n  ')}`);
  log(`包 ${info.filename}：${files.length} 个文件，${(info.size / 1024).toFixed(0)} KB（解压 ${(info.unpackedSize / 1024).toFixed(0)} KB）`);

  // exactly what the README tells users: `npx ./storyscript-mov-<v>.tgz …` next to the tarball
  const tarball = `./${info.filename}`;
  const work = packDir;
  const home = join(tmp, 'home-pack');
  const env = envFor(home, cache, registry);
  const doctor = (await mustRun('npx <tgz> doctor', 'npx', ['--yes', tarball, 'doctor'], { cwd: work, env, timeoutMs: 15 * 60_000 })).stdout;
  check(/\[正常\] Node\.js/.test(doctor), `doctor 输出缺少 Node 检查：\n${tail(doctor)}`);
  check(/\[正常\] 前端产物/.test(doctor), `doctor 没有找到包内的前端产物：\n${tail(doctor)}`);
  check(doctor.includes(join(home, ...STATE_REL)), `doctor 没有使用临时 HOME 下的状态目录：\n${tail(doctor)}`);

  const port = await freePort();
  const server = await exerciseServer('npx <tgz> start', 'npx', ['--yes', tarball, 'start', '--no-open', '--port', String(port)], {
    cwd: work,
    env,
    home,
    port,
    bootMs: 5 * 60_000,
  });
  const demoPort = await freePort();
  const demo = await exerciseServer('npx <tgz> --demo', 'npx', ['--yes', tarball, '--demo', '--no-open', '--port', String(demoPort)], {
    cwd: work,
    env,
    home,
    port: demoPort,
    bootMs: 5 * 60_000,
    demo: true,
  });
  return { tarball: info.filename, size: info.size, unpacked_size: info.unpackedSize, files, doctor_exit: 0, doctor: doctor.trim().split('\n'), server, demo };
}

async function sourcePath({ tmp, cache, registry }) {
  const src = join(tmp, 'src');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  check(/^[0-9a-f]{40}$/.test(head), '无法读取当前仓库的 HEAD（需要 git 仓库）');
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (dirty) log('注意：工作区有未提交的改动，源码路径只验证已提交的 HEAD');
  await mustRun('克隆（git clone file://）', 'git', ['clone', '--quiet', '--no-checkout', `file://${ROOT}`, src], { timeoutMs: 5 * 60_000 });
  const has = spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: src });
  if (has.status !== 0) await mustRun('取回 HEAD', 'git', ['fetch', '--quiet', 'origin', head], { cwd: src });
  await mustRun('检出 HEAD', 'git', ['checkout', '--quiet', '--detach', head], { cwd: src });

  const home = join(tmp, 'home-source');
  const env = envFor(home, cache, registry);
  await mustRun('安装依赖（npm ci）', 'npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: src, env, timeoutMs: 20 * 60_000 });
  const port = await freePort();
  const server = await exerciseServer('npm start', 'npm', ['start', '--', '--', '--no-open', '--port', String(port)], {
    cwd: src,
    env,
    home,
    port,
    bootMs: 5 * 60_000,
  });
  return { commit: head, dirty_worktree: Boolean(dirty), server };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'skip-build': { type: 'boolean', default: false },
      only: { type: 'string' },
      cache: { type: 'string' },
      report: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  if (values.only && !['pack', 'source'].includes(values.only)) {
    console.error('--only 只能是 pack 或 source');
    return 2;
  }
  if (process.platform === 'win32') {
    // npm/npx are .cmd shims there (need a shell) and process groups differ; v0.1 verifies macOS + Linux only
    console.error('[smoke] Windows 未验证（SPEC §1），此脚本只支持 macOS 和 Linux');
    return 2;
  }
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ssm-smoke-')));
  const cache = values.cache ? resolve(values.cache) : join(tmp, 'npm-cache');
  const registry = userRegistry();
  const report = { ok: false, node: process.versions.node, platform: `${process.platform}-${process.arch}`, registry, fresh_cache: !values.cache, pack: null, source: null, error: null };
  const t0 = Date.now();
  log(`临时目录 ${tmp}（HOME 与 npm 缓存都在其中），registry ${registry}`);
  try {
    if (values.only !== 'source') report.pack = await packPath({ tmp, cache, registry, skipBuild: values['skip-build'] });
    if (values.only !== 'pack') report.source = await sourcePath({ tmp, cache, registry });
    report.ok = true;
    log(`全部通过（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] 失败：${report.error}`);
    if (!(err instanceof SmokeError) && err instanceof Error) console.error(err.stack);
  } finally {
    report.seconds = Math.round((Date.now() - t0) / 1000);
    if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
    if (values.keep) log(`保留临时目录：${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
