import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Email } from '@storyscript/contracts';
import { SHUTDOWN_GRACE_MS } from '../shutdown.ts';
import {
  HostedLimits,
  TEAM_SLUG,
  hashInvite,
  hostedConfigExists,
  normalizeInvite,
  normalizeOrigin,
  normalizeSender,
  readHostedConfig,
  serverConfigPath,
  showJoinCode,
  teamDir,
  writeHostedConfig,
  type HostedConfig,
} from './config.ts';
import { mailerFromEnv } from './mail/mailer.ts';
import { codeEmail } from './mail/templates.ts';
import { SiteDb } from './site-db.ts';
import { runningServerPid, startHostedServer } from './start.ts';

export const SERVER_HELP = `storyscript-mov server — 服务器版（邮箱注册，学生自建小组，素材留在各自电脑上）

用法：
  storyscript-mov server init --data <目录> --origin <公开地址> --invite <邀请码> --mail-from <发件地址>
                              [--port 4700] [--listen 127.0.0.1] [--name 站点名] [--timezone Asia/Shanghai]
  storyscript-mov server start --data <目录>
  storyscript-mov server invite set <邀请码> --data <目录>     更换注册邀请码（先停止服务）
  storyscript-mov server user list --data <目录>
  storyscript-mov server user remove <邮箱> --data <目录>      删除账号（该账号立即退出登录）
  storyscript-mov server team list --data <目录>
  storyscript-mov server team remove <代号> --data <目录>      删除小组（先停止服务；项目文件保留在 teams/<代号>/）
  storyscript-mov server mail test <邮箱> --data <目录>        发一封测试邮件

  --data 也可以用环境变量 STORYSCRIPT_DATA 指定。
  公开地址只写协议和域名，例如 https://story.example.com（不支持子路径）。
  发信：环境变量 STORYSCRIPT_RESEND_API_KEY（Resend 的 API key）；发件地址的域名要先在 Resend 验证。
  模型 key：环境变量 STORYSCRIPT_LLM_* / STORYSCRIPT_IMAGE_*。
  上限在 server.json 的 limits 里：每组 24 小时文本 200 次、图像 20 次；全站每天邮件 100 封；小组 60 个，每组 12 人；每人最多同时在 2 个小组。`;

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

function refuseWhileRunning(dataDir: string, what: string): boolean {
  const pid = runningServerPid(dataDir);
  if (pid) console.error(`服务正在运行（进程 ${pid}）。请先停止服务，${what}后再启动。`);
  return pid !== null;
}

function checkInvite(code: string | undefined): string | null {
  const n = code ? normalizeInvite(code) : '';
  if (n.length < 4 || n.length > 100) {
    console.error('需要邀请码（4–100 个字符，不区分大小写）');
    return null;
  }
  return n;
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
        invite: { type: 'string' },
        'mail-from': { type: 'string' },
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
    if (!values['mail-from']) return fail('需要 --mail-from <发件地址>，例如 noreply@story.example.com（域名要先在 Resend 验证）');
    let origin: string;
    let from: string;
    try {
      origin = normalizeOrigin(values.origin);
      from = normalizeSender(values['mail-from']);
    } catch (err) {
      return fail((err as Error).message);
    }
    const invite = checkInvite(values.invite);
    if (!invite) return 2;
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
      version: 2,
      site_name: values.name ?? 'StoryScript-Mov',
      public_origin: origin,
      listen_host: values.listen ?? '127.0.0.1',
      port,
      timezone,
      invite_sha256: hashInvite(invite),
      mail: { from },
      limits: HostedLimits.parse({}),
    };
    writeHostedConfig(dataDir, config);
    SiteDb.open(dataDir).close();
    console.log(`已创建 ${serverConfigPath(dataDir)}`);
    console.log(`注册邀请码已设置（服务器上只保存它的哈希），发件人：${from}`);
    if (!origin.startsWith('https://')) console.log('注意：公开地址不是 https。浏览器只在 HTTPS 下才能记住本机素材文件夹，登录 cookie 也不加密传输。');
    console.log(`下一步：设置环境变量 STORYSCRIPT_RESEND_API_KEY，然后 storyscript-mov server start --data ${dataDir}`);
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

  const config = loadOrFail(dataDir);
  if (!config) return 1;

  if (cmd === 'invite') {
    if (sub !== 'set') return fail(`未知命令：server invite ${sub ?? ''}\n\n${SERVER_HELP}`);
    const invite = checkInvite(arg);
    if (!invite) return 2;
    if (refuseWhileRunning(dataDir, '换好邀请码')) return 1;
    writeHostedConfig(dataDir, { ...config, invite_sha256: hashInvite(invite) });
    console.log('注册邀请码已更换。已注册的账号不受影响。');
    return 0;
  }

  if (cmd === 'mail') {
    if (sub !== 'test') return fail(`未知命令：server mail ${sub ?? ''}\n\n${SERVER_HELP}`);
    const to = Email.safeParse(arg ?? '');
    if (!to.success) return fail('需要收件邮箱，例如 server mail test me@example.com');
    const mailer = mailerFromEnv(process.env, config.mail.from);
    const message = codeEmail({ purpose: 'test', code: '', siteName: config.site_name, origin: config.public_origin, minutes: 10 });
    try {
      await mailer.send({ to: to.data, ...message });
    } catch (err) {
      return fail(`没有发出去：${(err as Error).message}`);
    }
    console.log(mailer.kind === 'outbox' ? `已写入发件箱目录 ${process.env.STORYSCRIPT_MAIL_OUTBOX}` : `已发送到 ${to.data}，发件人 ${config.mail.from}`);
    return 0;
  }

  if (cmd === 'user') {
    const site = SiteDb.open(dataDir);
    try {
      if (sub === 'list') {
        const accounts = site.listAccounts();
        if (accounts.length === 0) console.log('还没有账号。');
        for (const a of accounts) {
          const groups = site
            .memberships(a.id)
            .map((m) => `${site.team(m.team_slug)?.name ?? m.team_slug}（${m.role === 'leader' ? '组长' : '组员'}）`);
          console.log(`${a.email}\t${a.name}\t${groups.length ? groups.join('、') : '未加入小组'}\t注册于 ${a.created_at.slice(0, 10)}`);
        }
        return 0;
      }
      if (sub !== 'remove') return fail(`未知命令：server user ${sub ?? ''}\n\n${SERVER_HELP}`);
      const email = Email.safeParse(arg ?? '');
      const account = email.success ? site.accountByEmail(email.data) : null;
      if (!account) return fail(`没有这个账号：${arg ?? ''}`);
      site.db.tx(() => {
        // the lead of each group passes to its earliest other member
        for (const m of site.memberships(account.id)) {
          if (m.role !== 'leader') continue;
          const next = site.members(m.team_slug).find((x) => x.id !== account.id);
          if (next) site.setRole(next.id, m.team_slug, 'leader');
        }
        site.deleteAccount(account.id);
      });
      console.log(`已删除账号 ${account.email}（${account.name}）。`);
      return 0;
    } finally {
      site.close();
    }
  }

  if (cmd === 'team') {
    const site = SiteDb.open(dataDir);
    try {
      if (sub === 'list') {
        const teams = site.listTeams();
        if (teams.length === 0) console.log('还没有小组。');
        for (const t of teams) {
          const members = site.members(t.slug);
          const leader = members.find((m) => m.role === 'leader');
          console.log(`${t.slug}\t${t.name}\t${members.length} 人${leader ? `，组长 ${leader.name}` : ''}\t组码 ${showJoinCode(t.join_code)}\t${teamDir(dataDir, t.slug)}`);
        }
        return 0;
      }
      if (sub !== 'remove') return fail(`未知命令：server team ${sub ?? ''}\n\n${SERVER_HELP}`);
      if (!arg || !TEAM_SLUG.test(arg)) return fail('需要小组代号（用 server team list 查看）');
      const team = site.team(arg);
      if (!team) return fail(`没有小组 ${arg}`);
      if (refuseWhileRunning(dataDir, '删好小组')) return 1;
      site.deleteTeam(arg);
      console.log(`已删除小组 ${team.name}（${arg}），组员回到"未加入小组"。项目文件保留在 ${teamDir(dataDir, arg)}`);
      return 0;
    } finally {
      site.close();
    }
  }

  return fail(`未知命令：server ${cmd}\n\n${SERVER_HELP}`);
}
