import { ApiClientError, isApiClientError, type ClientErrorCode } from './api.ts';

/** Plain-language (Chinese) explanation of an error, plus the raw code for bug reports. */
export interface HumanError {
  title: string;
  detail: string | null;
  /** e.g. "PROJECT_LOCKED（HTTP 423）：project is locked" */
  technical: string | null;
}

/** Where the error happened; changes wording for ambiguous codes like NOT_FOUND. */
export type ErrorContext =
  | 'general'
  | 'open'
  | 'create'
  | 'choose-folder'
  | 'shot-save'
  | 'apply-breakdown'
  | 'provider'
  | 'ai-request'
  | 'script-import'
  /** set log and media library (takes, roots, assets, links, coverage) */
  | 'media'
  /** hosted server: signing in with a team code */
  | 'sign-in';

type Copy = { title: string; detail: string | null };

const COPY: Record<ClientErrorCode, Copy> = {
  VALIDATION_ERROR: { title: '填写的内容有误', detail: '请检查标出的字段后重试。' },
  NOT_FOUND: { title: '要找的内容不存在', detail: '它可能已被删除或移动。' },
  REVISION_CONFLICT: { title: '内容已在别处被修改', detail: '刷新后再做一次修改。' },
  LOCKED_SHOT: { title: '镜头已锁定', detail: '先解除锁定再修改。' },
  SOURCE_OFFLINE: { title: '原片不在线', detail: '存放素材的磁盘可能没有接上。' },
  SOURCE_CHANGED: { title: '原片在导入后被改动过', detail: '文件大小或修改时间与登记时不一致。' },
  PATH_NOT_ALLOWED: { title: '这个路径不能使用', detail: '请换一个目录。' },
  MISSING_CONFIRMATION: { title: '这一步需要先确认', detail: null },
  UNSUPPORTED_MEDIA: { title: '不支持的素材格式', detail: null },
  UNSUPPORTED_TIMEBASE: { title: '不支持的时间基', detail: null },
  PROVIDER_NOT_CONFIGURED: { title: '还没有配置模型', detail: '在设置里查看配置方式。没有模型时，手工流程照常可用。' },
  PROVIDER_ERROR: { title: '模型服务返回错误', detail: null },
  PROVIDER_OUTCOME_UNKNOWN: { title: '无法确认模型请求是否成功', detail: '为避免重复计费，不会自动重发。' },
  PROVIDER_REFUSED: { title: '模型拒绝了这次请求', detail: null },
  ATTEMPTS_EXHAUSTED: {
    title: '已达到本步骤的最大尝试次数',
    detail: '每一步最多向外发送 3 次请求，网络重试、限流、解析失败和校验失败都计入。可以调整参考说明或镜头上限后重新发起。',
  },
  FFMPEG_MISSING: { title: '没有找到 ffmpeg', detail: '素材导入需要 ffmpeg 和 ffprobe。用 brew install ffmpeg 安装后，重启 storyscript-mov。' },
  PROJECT_LOCKED: {
    title: '这个项目正在别处打开',
    detail: '另一个 StoryScript-Mov 进程持有项目锁（project.lock）。先在那边关闭项目；如果那个进程已经退出，再打开一次即可接管。',
  },
  QUOTA_EXCEEDED: { title: '已达到本项目的生成上限', detail: '这是防止意外花费的软上限，可以在设置里调高。' },
  PROJECT_EXISTS: { title: '这个目录里已经有项目了', detail: '请用"打开已有项目"打开它，或者换一个空目录新建。' },
  NO_PROJECT_OPEN: { title: '当前没有打开的项目', detail: '回到首页打开或新建一个项目。' },
  SCHEMA_VERSION_UNSUPPORTED: {
    title: '无法打开这个版本的项目',
    detail: '项目的数据格式版本（schema_version）不受当前版本支持，通常是因为它由更新版本的 StoryScript-Mov 创建。升级 storyscript-mov 后再打开。',
  },
  UNAUTHORIZED: { title: '会话已失效', detail: '请使用终端打印的链接，或运行 storyscript-mov open' },
  FORBIDDEN: { title: '请求被本地服务拒绝', detail: '来源校验没有通过。请用终端打印的链接重新打开页面。' },
  TOO_MANY_ATTEMPTS: { title: '尝试次数太多', detail: '队伍口令连续输错，这台电脑暂时不能登录。过一会儿再试，或向管理员要邀请链接。' },
  INTERNAL: { title: '本地服务出错', detail: '终端里有详细日志。' },
  NETWORK_ERROR: { title: '连接不上本地服务', detail: '确认运行 storyscript-mov 的终端窗口还开着，然后重试。' },
  BAD_RESPONSE: { title: '本地服务返回了无法识别的数据', detail: '页面与服务的版本可能不一致。刷新页面；仍然出现就重启 storyscript-mov。' },
};

const CONTEXT_COPY: Partial<Record<ErrorContext, Partial<Record<ClientErrorCode, Copy>>>> = {
  open: {
    NOT_FOUND: {
      title: '这个目录里没有 StoryScript-Mov 项目',
      detail: '没有找到 project.json。确认路径指向项目目录本身，而不是它的上级目录；目录被移动过的话，请重新选择。',
    },
  },
  create: {
    NOT_FOUND: { title: '找不到这个目录', detail: '确认路径拼写正确，并且目录所在的磁盘已经接上。' },
  },
  'shot-save': {
    REVISION_CONFLICT: { title: '这个镜头已在别处修改', detail: '请刷新后重试。你在表单里的改动还在，可以对照最新内容再保存。' },
    LOCKED_SHOT: { title: '镜头已锁定', detail: '锁定的镜头不能修改。先解除锁定再保存。' },
    NOT_FOUND: { title: '这个镜头已不存在', detail: '它可能已被归档或删除。刷新后查看。' },
  },
  'apply-breakdown': {
    REVISION_CONFLICT: { title: '本场镜头已在别处修改，请刷新后重试', detail: '为避免覆盖别处的改动，这次没有写入任何镜头。' },
    LOCKED_SHOT: { title: '有镜头在此期间被锁定', detail: '锁定的镜头不会被改动。刷新草案后重新勾选。' },
    NOT_FOUND: { title: '草案已不存在', detail: '它可能已被应用或放弃。' },
  },
  provider: {
    PROVIDER_ERROR: { title: '模型服务返回错误', detail: '检查 base_url、模型名和 key 是否正确。' },
  },
  'ai-request': {
    PROVIDER_NOT_CONFIGURED: { title: '还没有配置文本模型', detail: '在"设置 → 模型"里填写 base_url、模型和 key。手工流程照常可用。' },
  },
  'sign-in': {
    UNAUTHORIZED: { title: '队伍口令不对', detail: '检查后重新输入，或使用管理员发的邀请链接。' },
    VALIDATION_ERROR: { title: '队伍口令不完整', detail: '口令是 16 位字母和数字，例如 ABCD-EFGH-JKMN-PQRS。' },
  },
  'script-import': {
    VALIDATION_ERROR: { title: '剧本内容无法导入', detail: null },
  },
  media: {
    UNSUPPORTED_MEDIA: {
      title: '不支持的素材格式',
      detail: '静态图片或无法读取时长的文件不能关联到镜头；非 H.264 视频需代理（v0.2）才能在浏览器播放。',
    },
    SOURCE_OFFLINE: { title: '原片不在线', detail: '存放素材的磁盘可能没有接上。接上后，在素材目录上点"检查"。' },
    // the media mutations that carry a revision refresh their lists when they settle
    REVISION_CONFLICT: { title: '内容已在别处被修改', detail: '列表已刷新，请在最新内容上再改一次。' },
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Best effort: who holds project.lock (details shape is server-defined). */
function lockHolder(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const parts: string[] = [];
  if (typeof details.hostname === 'string' && details.hostname) parts.push(`主机 ${details.hostname}`);
  if (typeof details.pid === 'number') parts.push(`进程 ${details.pid}`);
  if (typeof details.started_at === 'string') {
    const d = new Date(details.started_at);
    if (!Number.isNaN(d.getTime())) parts.push(`自 ${d.toLocaleString('zh-CN')} 起`);
  }
  return parts.length > 0 ? parts.join('，') : null;
}

export function technicalLine(e: ApiClientError): string {
  const status = e.status > 0 ? `（HTTP ${e.status}）` : '';
  return `${e.code}${status}：${e.message}`;
}

export function describeError(error: unknown, context: ErrorContext = 'general'): HumanError {
  if (!isApiClientError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return { title: '出现了意外错误', detail: '刷新页面后重试。', technical: message };
  }

  if (context === 'choose-folder' && error.code !== 'UNAUTHORIZED' && error.code !== 'NETWORK_ERROR') {
    return {
      title: '无法弹出系统的文件夹选择框',
      detail: '可以直接把完整路径粘贴到输入框里。',
      technical: technicalLine(error),
    };
  }

  // The server answers "not in this state" with VALIDATION_ERROR + 409 (draft
  // already applied, draft made for an older script version, shot archived…):
  // nothing the user typed is wrong, so say what the server said.
  if (error.code === 'VALIDATION_ERROR' && error.status === 409) {
    return { title: '当前状态下不能这样操作', detail: error.message || null, technical: technicalLine(error) };
  }

  const copy = CONTEXT_COPY[context]?.[error.code] ?? COPY[error.code];
  let detail = copy.detail;
  if (error.code === 'PROJECT_LOCKED') {
    const holder = lockHolder(error.details);
    if (holder) detail = `${detail ?? ''}占用者：${holder}。`;
  }
  if (
    error.code === 'VALIDATION_ERROR' ||
    error.code === 'PATH_NOT_ALLOWED' ||
    error.code === 'PROVIDER_ERROR' ||
    error.code === 'PROVIDER_REFUSED' ||
    error.code === 'UNSUPPORTED_MEDIA'
  ) {
    // Server messages here are specific ("directory is not empty", why a clip
    // cannot be linked or played…); show them.
    detail = error.message ? `${copy.detail ?? ''}${copy.detail ? ' ' : ''}原因：${error.message}` : copy.detail;
  }
  return { title: copy.title, detail, technical: technicalLine(error) };
}

function isKnownCode(code: string): code is ClientErrorCode {
  return Object.prototype.hasOwnProperty.call(COPY, code);
}

/**
 * Job codes the server writes that are not API error codes
 * (apps/server jobs/queue.ts: a job left over from a previous process).
 */
const JOB_ONLY_COPY: Readonly<Record<string, Copy>> = {
  INTERRUPTED: { title: '任务被中断', detail: '服务重启时任务还没有发出请求，可以重新发起。' },
};

/** Codes whose server message carries the specific reason (last problem, HTTP status…). */
const JOB_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_ERROR',
  'PROVIDER_REFUSED',
  'VALIDATION_ERROR',
  'ATTEMPTS_EXHAUSTED',
  'INTERNAL',
]);

/**
 * Job.error ({ code, message }) in the same plain-language form. Most jobs
 * are model requests ('ai-request'); media scans pass 'media'.
 */
export function describeJobError(error: { code: string; message: string } | null, context: ErrorContext = 'ai-request'): HumanError | null {
  if (!error) return null;
  const technical = `${error.code}：${error.message}`;
  const known = JOB_ONLY_COPY[error.code] ?? (isKnownCode(error.code) ? (CONTEXT_COPY[context]?.[error.code] ?? COPY[error.code]) : null);
  if (known) {
    const showMessage = JOB_MESSAGE_CODES.has(error.code) && error.message;
    const detail = showMessage ? `${known.detail ?? ''}${known.detail ? ' ' : ''}原因：${error.message}` : known.detail;
    return { title: known.title, detail, technical };
  }
  return { title: '任务失败', detail: error.message || null, technical };
}

/**
 * True for REVISION_CONFLICT only (optimistic concurrency). The server also
 * answers 409 for LOCKED_SHOT, NO_PROJECT_OPEN, PROVIDER_NOT_CONFIGURED and
 * state errors, which a "reload and retry" cannot fix.
 */
export function isRevisionConflict(error: unknown): boolean {
  return isApiClientError(error) && error.code === 'REVISION_CONFLICT';
}
