import { parseArgs } from 'node:util';
import { readRuntime, resolveStateDir } from './config/paths.ts';
import { runDoctor } from './doctor.ts';
import { isPidAlive } from './project/lock.ts';
import { startServer } from './server.ts';
import { APP_VERSION } from './version.ts';

const HELP = `StoryScript-Mov ${APP_VERSION} — 本地运行的实拍分镜工作台

用法：storyscript-mov [命令] [选项]

命令：
  start    启动服务（默认）
  doctor   检查运行环境（Node、SQLite、ffmpeg、状态目录）
  open     在浏览器中重新打开正在运行的服务

选项：
  --port <n>   监听端口（默认随机；只监听 127.0.0.1）
  --no-open    不自动打开浏览器
  --dev        开发模式（Vite 中间件，仅限源码仓库）
  --demo       演示模式
  -h, --help   显示帮助
  -v, --version 显示版本

环境变量：STORYSCRIPT_HOME 指定状态目录（默认 ~/.config/storyscript-mov）`;

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

async function openBrowser(url: string): Promise<boolean> {
  try {
    const { default: open } = await import('open');
    await open(url);
    return true;
  } catch {
    return false;
  }
}

async function cmdOpen(noOpen: boolean): Promise<number> {
  const rt = readRuntime(resolveStateDir());
  if (!rt || !isPidAlive(rt.pid)) {
    console.error('StoryScript-Mov 服务未运行。请先启动：npx storyscript-mov（源码仓库中用 npm start）');
    return 1;
  }
  const url = `http://127.0.0.1:${rt.port}/#t=${rt.token}`;
  console.log(`服务正在运行（pid ${rt.pid}）：${url}`);
  if (!noOpen && !(await openBrowser(url))) console.log('无法自动打开浏览器，请手动复制上面的链接。');
  return 0;
}

async function cmdStart(opts: { port: number; noOpen: boolean; dev: boolean; demo: boolean }): Promise<number | undefined> {
  const server = await startServer({
    mode: opts.dev ? 'development' : 'production',
    port: opts.port,
    open: !opts.noOpen,
    demo: opts.demo,
  });
  const shutdown = (signal: NodeJS.Signals) => {
    void server.close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return undefined;
}

/** CLI entry (after the Node version shim). Returns an exit code, or undefined while the server keeps running. */
export async function main(argv: string[]): Promise<number | undefined> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        dev: { type: 'boolean', default: false },
        demo: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    console.error(`参数错误：${(err as Error).message}\n`);
    console.error(HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(APP_VERSION);
    return 0;
  }
  const command = positionals[0] ?? 'start';
  if (positionals.length > 1) {
    console.error(`多余的参数：${positionals.slice(1).join(' ')}\n`);
    console.error(HELP);
    return 2;
  }

  switch (command) {
    case 'start': {
      const port = parsePort(values.port);
      if (port === null) {
        console.error(`无效的端口：${values.port}（应为 0–65535 的整数）`);
        return 2;
      }
      try {
        return await cmdStart({ port, noOpen: values['no-open'], dev: values.dev, demo: values.demo });
      } catch (err) {
        console.error(`启动失败：${(err as Error).message}`);
        return 1;
      }
    }
    case 'doctor':
      return runDoctor();
    case 'open':
      return cmdOpen(values['no-open']);
    default:
      console.error(`未知命令：${command}\n`);
      console.error(HELP);
      return 2;
  }
}
