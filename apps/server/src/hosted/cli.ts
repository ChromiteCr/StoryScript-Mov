import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SHUTDOWN_GRACE_MS } from '../shutdown.ts';
import {
  TEAM_SLUG,
  generateTeamCode,
  hashTeamCode,
  hostedConfigExists,
  inviteLink,
  normalizeOrigin,
  readHostedConfig,
  serverConfigPath,
  teamDir,
  writeHostedConfig,
  type HostedConfig,
} from './config.ts';
import { HostedSessions } from './sessions.ts';
import { runningServerPid, startHostedServer } from './start.ts';

export const SERVER_HELP = `storyscript-mov server — 服务器版（多个队伍共用一个网站，素材留在各自电脑上）

用法：
  storyscript-mov server init --data <目录> --origin <公开地址> [--port 4700] [--listen 127.0.0.1] [--name 站点名] [--timezone Asia/Shanghai]
  storyscript-mov server team add <代号> --name <队名> --data <目录>
  storyscript-mov server team list --data <目录>
  storyscript-mov server team reset <代号> --data <目录>      重新生成口令（旧口令和已登录的浏览器全部失效）
  storyscript-mov server team remove <代号> --data <目录>     停用队伍（项目文件保留在 teams/<代号>/）
  storyscript-mov server start --data <目录>

  --data 也可以用环境变量 STORYSCRIPT_DATA 指定。
  公开地址只写协议和域名，例如 https://story.example.com（不支持子路径）。
  修改队伍前请先停止服务；模型 key 用环境变量 STORYSCRIPT_LLM_* / STORYSCRIPT_IMAGE_* 配置。
  代号：小写字母、数字和连字符，例如 team-1。`;

function fail(message: string): number {
  console.error(message);
  return 2;
}

function dataDirOf(value: string | undefined): string | null {
  const d = value ?? process.env.STORYSCRIPT_DATA;
  return d && d.trim() ? resolve(d.trim()) : null;
}

function loadOrFail(dataDir: string): HostedConfig | null {
  const config = readHostedConfig(dataDir);
  if (!config) console.error(`找不到或无法读取 ${serverConfigPath(dataDir)}：先运行 storyscript-mov server init`);
  return config;
}

function refuseWhileRunning(dataDir: string): boolean {
  const pid = runningServerPid(dataDir);
  if (pid) console.error(`服务正在运行（进程 ${pid}）。请先停止服务，改完队伍再启动。`);
  return pid !== null;
}

function printCode(config: HostedConfig, name: string, code: string): void {
  console.log(`队伍：${name}`);
  console.log(`口令：${code}`);
  console.log(`邀请链接：${inviteLink(config, code)}`);
  console.log('口令只显示这一次，服务器上只保存它的哈希。请发给队员，丢了可以用 team reset 重新生成。');
}

export async function runServerCli(argv: string[]): Promise<number | undefined> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        data: { type: 'string' },
        origin: { type: 'string' },
        port: { type: 'string' },
        listen: { type: 'string' },
        name: { type: 'string' },
        timezone: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    return fail(`参数错误：${(err as Error).message}\n\n${SERVER_HELP}`);
  }
  const { values, positionals } = parsed;
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) {
    console.log(SERVER_HELP);
    return 0;
  }
  const dataDir = dataDirOf(values.data);
  if (!dataDir) return fail('需要 --data <目录>（或环境变量 STORYSCRIPT_DATA）');

  if (cmd === 'init') {
    if (hostedConfigExists(dataDir)) return fail(`${serverConfigPath(dataDir)} 已存在，不会覆盖`);
    if (!values.origin) return fail('需要 --origin <公开地址>，例如 https://story.example.com');
    let origin: string;
    try {
      origin = normalizeOrigin(values.origin);
    } catch (err) {
      return fail((err as Error).message);
    }
    const port = values.port === undefined ? 4700 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`无效的端口：${values.port}`);
    const timezone = values.timezone ?? 'Asia/Shanghai';
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      return fail(`无效的时区：${timezone}`);
    }
    const config: HostedConfig = {
      format: 'storyscript-mov-server',
      version: 1,
      site_name: values.name ?? 'StoryScript-Mov',
      public_origin: origin,
      listen_host: values.listen ?? '127.0.0.1',
      port,
      timezone,
      teams: [],
    };
    writeHostedConfig(dataDir, config);
    console.log(`已创建 ${serverConfigPath(dataDir)}`);
    if (!origin.startsWith('https://')) console.log('注意：公开地址不是 https。浏览器只在 HTTPS 下才能记住本机素材文件夹，登录 cookie 也不加密传输。');
    console.log('下一步：storyscript-mov server team add <代号> --name <队名> --data ' + dataDir);
    return 0;
  }

  if (cmd === 'team') {
    const config = loadOrFail(dataDir);
    if (!config) return 1;
    if (sub === 'list') {
      const sessions = HostedSessions.inDataDir(dataDir);
      if (config.teams.length === 0) console.log('还没有队伍。');
      for (const t of config.teams) console.log(`${t.slug}\t${t.name}\t已登录浏览器 ${sessions.count(t.slug)}\t${teamDir(dataDir, t.slug)}`);
      return 0;
    }
    if (sub !== 'add' && sub !== 'reset' && sub !== 'remove') return fail(`未知命令：server team ${sub ?? ''}\n\n${SERVER_HELP}`);
    if (!arg || !TEAM_SLUG.test(arg)) return fail('需要队伍代号：小写字母、数字和连字符，例如 team-1');
    if (refuseWhileRunning(dataDir)) return 1;
    const existing = config.teams.find((t) => t.slug === arg);

    if (sub === 'add') {
      if (existing) return fail(`队伍 ${arg} 已存在；要换口令用 team reset`);
      const name = values.name?.trim();
      if (!name) return fail('需要 --name <队名>');
      const code = generateTeamCode();
      config.teams.push({ slug: arg, name, code_sha256: hashTeamCode(code), created_at: new Date().toISOString() });
      writeHostedConfig(dataDir, config);
      printCode(config, name, code);
      return 0;
    }
    if (!existing) return fail(`没有队伍 ${arg}`);
    HostedSessions.inDataDir(dataDir).revokeTeam(arg);
    if (sub === 'reset') {
      const code = generateTeamCode();
      existing.code_sha256 = hashTeamCode(code);
      writeHostedConfig(dataDir, config);
      printCode(config, existing.name, code);
      return 0;
    }
    config.teams = config.teams.filter((t) => t.slug !== arg);
    writeHostedConfig(dataDir, config);
    console.log(`已停用队伍 ${existing.name}（${arg}）。项目文件保留在 ${teamDir(dataDir, arg)}`);
    return 0;
  }

  if (cmd === 'start') {
    try {
      const server = await startHostedServer({ dataDir });
      let stopping = false;
      const shutdown = (signal: NodeJS.Signals) => {
        if (stopping) return;
        stopping = true;
        const code = signal === 'SIGINT' ? 130 : 0;
        setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
        void server.close().finally(() => process.exit(code));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return undefined;
    } catch (err) {
      console.error(`启动失败：${(err as Error).message}`);
      return 1;
    }
  }

  return fail(`未知命令：server ${cmd}\n\n${SERVER_HELP}`);
}
