import { ApiClientError, isApiClientError, type ClientErrorCode } from './api.ts';

/** Plain-language (Chinese) explanation of an error, plus the raw code for bug reports. */
export interface HumanError {
  title: string;
  detail: string | null;
  /** e.g. "PROJECT_LOCKED（HTTP 423）：project is locked" */
  technical: string | null;
}

/** Where the error happened; changes wording for ambiguous codes like NOT_FOUND. */
export type ErrorContext = 'general' | 'open' | 'create' | 'choose-folder';

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
  ATTEMPTS_EXHAUSTED: { title: '已达到本步骤的最大尝试次数', detail: '每一步最多向外发送 3 次请求。' },
  FFMPEG_MISSING: { title: '没有找到 ffmpeg', detail: '素材导入需要 ffmpeg 和 ffprobe。用 brew install ffmpeg 安装后，重启 storyscript-mov。' },
  PROJECT_LOCKED: {
    title: '这个项目正在别处打开',
    detail: '另一个 StoryScript-Mov 进程持有项目锁（project.lock）。先在那边关闭项目；如果那个进程已经退出，再打开一次即可接管。',
  },
  PROJECT_EXISTS: { title: '这个目录里已经有项目了', detail: '请用"打开已有项目"打开它，或者换一个空目录新建。' },
  NO_PROJECT_OPEN: { title: '当前没有打开的项目', detail: '回到首页打开或新建一个项目。' },
  SCHEMA_VERSION_UNSUPPORTED: {
    title: '无法打开这个版本的项目',
    detail: '项目的数据格式版本（schema_version）不受当前版本支持，通常是因为它由更新版本的 StoryScript-Mov 创建。升级 storyscript-mov 后再打开。',
  },
  UNAUTHORIZED: { title: '会话已失效', detail: '请使用终端打印的链接，或运行 storyscript-mov open' },
  FORBIDDEN: { title: '请求被本地服务拒绝', detail: '来源校验没有通过。请用终端打印的链接重新打开页面。' },
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

  const copy = CONTEXT_COPY[context]?.[error.code] ?? COPY[error.code];
  let detail = copy.detail;
  if (error.code === 'PROJECT_LOCKED') {
    const holder = lockHolder(error.details);
    if (holder) detail = `${detail ?? ''}占用者：${holder}。`;
  }
  if (error.code === 'VALIDATION_ERROR' || error.code === 'PATH_NOT_ALLOWED') {
    // Server messages here are specific ("directory is not empty"…); show them.
    detail = error.message ? `${copy.detail ?? ''}${copy.detail ? ' ' : ''}原因：${error.message}` : copy.detail;
  }
  return { title: copy.title, detail, technical: technicalLine(error) };
}
