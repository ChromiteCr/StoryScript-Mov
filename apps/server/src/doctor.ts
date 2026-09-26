import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickH264Encoder } from './adapters/media/ffmpeg.ts';
import { ensureStateDir, resolveStateDir } from './config/paths.ts';
import { detectTools } from './diagnostics.ts';
import { MIN_NODE_TEXT, nodeVersionOk } from './node-version.ts';
import { APP_VERSION } from './version.ts';

/**
 * `storyscript-mov doctor` — environment report.
 * Exit code 0 when Node, SQLite and the state directory are usable;
 * missing ffmpeg/ffprobe is only a warning (media import is disabled).
 */

type Level = 'ok' | 'warn' | 'error';
const TAG: Record<Level, string> = { ok: '[正常]', warn: '[警告]', error: '[错误]' };

export interface DoctorOptions {
  stateDir?: string;
  log?: (line: string) => void;
}

async function checkSqlite(): Promise<{ level: Level; line: string }> {
  let dir: string | null = null;
  try {
    const { openDb, sqliteVersion, fts5Available } = await import('./db/port.ts');
    dir = mkdtempSync(join(tmpdir(), 'ssm-doctor-'));
    const db = openDb(join(dir, 'probe.sqlite'));
    const mode = db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode;
    db.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES (\'客厅\')');
    await db.backup(join(dir, 'probe-backup.sqlite'));
    db.close();
    if (mode !== 'wal') return { level: 'error', line: `SQLite ${sqliteVersion()}：WAL 模式不可用（得到 ${mode}）` };
    const fts = fts5Available() ? 'FTS5 可用' : 'FTS5 不可用（v0.1 只用 LIKE 检索，不受影响）';
    return { level: 'ok', line: `SQLite ${sqliteVersion()}（node:sqlite，WAL 与在线备份正常，${fts}）` };
  } catch (err) {
    return { level: 'error', line: `node:sqlite 不可用：${(err as Error).message}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function checkStateDir(stateDir: string): { level: Level; line: string } {
  try {
    ensureStateDir(stateDir);
    const probe = join(stateDir, `.doctor-${process.pid}.tmp`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { level: 'ok', line: `状态目录可写：${stateDir}` };
  } catch (err) {
    return { level: 'error', line: `状态目录不可写：${stateDir}（${(err as Error).message}）。可用环境变量 STORYSCRIPT_HOME 指定其他目录` };
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const stateDir = opts.stateDir ?? resolveStateDir();
  const results: Array<{ level: Level; line: string }> = [];
  const add = (level: Level, line: string) => {
    results.push({ level, line });
    log(`${TAG[level]} ${line}`);
  };

  log(`StoryScript-Mov ${APP_VERSION} 环境检查`);
  const node = process.versions.node;
  if (nodeVersionOk(node)) add('ok', `Node.js ${node}（要求 ≥ ${MIN_NODE_TEXT}）`);
  else add('error', `Node.js ${node} 版本过低，需要 ≥ ${MIN_NODE_TEXT}`);

  const sqlite = await checkSqlite();
  add(sqlite.level, sqlite.line);

  const tools = await detectTools();
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const t = tools[name];
    if (t.path) add('ok', `${name}：${t.path}（版本 ${t.version ?? '未知'}）`);
    else add('warn', `未找到 ${name}：应用可以启动，但素材导入不可用。安装：brew install ffmpeg`);
  }
  if (tools.ffmpeg.path) {
    const enc = pickH264Encoder(tools.h264_encoders);
    if (enc) add('ok', `H.264 编码器：${enc}（可用：${tools.h264_encoders.join('、')}）`);
    else add('warn', '未找到可用的 H.264 编码器（libx264 / h264_videotoolbox / libopenh264）');
  }

  const dir = checkStateDir(stateDir);
  add(dir.level, dir.line);

  const errors = results.filter((r) => r.level === 'error').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  log(errors ? `发现 ${errors} 个错误，请按提示修复。` : warnings ? `可以运行（${warnings} 个警告）。` : '一切正常。');
  return errors ? 1 : 0;
}
