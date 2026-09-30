import { Api, ApiError, type ErrorCode } from '@storyscript/contracts';

let requestTab: string | null = null;

/** S4a: the id this browser tab sends with its requests (set by the change-feed poller). */
export function setRequestTab(id: string | null): void {
  requestTab = id;
}

/** Headers that tell the change feed which tab wrote (for requests made outside api.call). */
export function tabHeaders(): Record<string, string> {
  return requestTab ? { 'X-SSM-Tab': requestTab } : {};
}

/**
 * Typed fetch client over the contracts `Api` table.
 * - request input validated with the contract schema before sending
 * - success `{ data }` unwrapped and validated with the output schema
 * - error envelope (common.ts ApiError) → ApiClientError with `code`
 * zod is reached only through the contract schemas (web has no direct zod dep).
 */

export interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Structural slice of a zod schema that the client relies on. */
export interface Schema<Out = unknown, In = Out> {
  readonly _output: Out;
  readonly _input: In;
  safeParse(data: unknown): { success: true; data: Out } | { success: false; error: { issues: readonly SchemaIssue[] } };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointDef {
  readonly method: HttpMethod;
  readonly path: string;
  readonly input?: Schema;
  readonly output?: Schema;
}

type ApiDefs = typeof Api;
export type EndpointName = keyof ApiDefs;
export type InputOf<K extends EndpointName> = ApiDefs[K] extends { input: { _input: infer I } } ? I : undefined;
export type OutputOf<K extends EndpointName> = ApiDefs[K] extends { output: { _output: infer O } } ? O : void;

/** Codes raised by the client itself, in addition to the server's ErrorCode. */
export type ClientOnlyCode = 'NETWORK_ERROR' | 'BAD_RESPONSE';
export type ClientErrorCode = ErrorCode | ClientOnlyCode;

export interface ApiClientErrorInit {
  code: ClientErrorCode;
  message: string;
  /** HTTP status; 0 when no response was received */
  status: number;
  retryable: boolean;
  details?: unknown;
  cause?: unknown;
}

export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(init: ApiClientErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.details = init.details;
  }
}

export function isApiClientError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}

export function isUnauthorized(e: unknown): boolean {
  return isApiClientError(e) && (e.code === 'UNAUTHORIZED' || e.status === 401);
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export interface CallOptions {
  signal?: AbortSignal;
  /** values for `:name` path segments */
  params?: Readonly<Record<string, string>>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type CallArgs<K extends EndpointName> = ApiDefs[K] extends { input: unknown }
  ? [input: InputOf<K>, opts?: CallOptions]
  : [input?: undefined, opts?: CallOptions];

export interface ApiClient {
  call<K extends EndpointName>(name: K, ...args: CallArgs<K>): Promise<OutputOf<K>>;
}

export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export function fillPath(path: string, params?: Readonly<Record<string, string>>): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key: string) => {
    const v = params?.[key];
    if (v === undefined) throw new Error(`missing path param: ${key}`);
    return encodeURIComponent(v);
  });
}

/** Fallback code when an error response carries no valid envelope. */
export function codeFromStatus(status: number): ClientErrorCode {
  if (status === 400 || status === 422) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'INTERNAL';
  return 'BAD_RESPONSE';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badResponse(message: string, status: number, details?: unknown): ApiClientError {
  return new ApiClientError({ code: 'BAD_RESPONSE', message, status, retryable: false, details });
}

/** Turn a Response into data or an ApiClientError. Exported for tests. */
export async function parseResponse(res: Response, output?: Schema): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiClientError({ code: 'NETWORK_ERROR', message: '读取响应失败', status: res.status, retryable: true, cause: e });
  }

  let json: unknown;
  let hasJson = false;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
      hasJson = true;
    } catch {
      hasJson = false;
    }
  }

  if (!res.ok) {
    if (hasJson) {
      const env = ApiError.safeParse(json);
      if (env.success) {
        const e = env.data.error;
        throw new ApiClientError({ code: e.code, message: e.message, status: res.status, retryable: e.retryable, details: e.details });
      }
      // Envelope-shaped but with an unknown code: keep the server message.
      if (isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string') {
        throw new ApiClientError({
          code: codeFromStatus(res.status),
          message: json.error.message,
          status: res.status,
          retryable: json.error.retryable === true,
          details: json.error,
        });
      }
    }
    throw new ApiClientError({
      code: codeFromStatus(res.status),
      message: `HTTP ${res.status}`,
      status: res.status,
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  if (text.length === 0) {
    if (output) throw badResponse('响应为空', res.status);
    return undefined;
  }
  if (!hasJson) throw badResponse('响应不是 JSON', res.status);
  if (!isRecord(json) || !('data' in json)) throw badResponse('响应缺少 { data } 信封', res.status);
  if (!output) return json.data;

  const parsed = output.safeParse(json.data);
  if (!parsed.success) {
    throw badResponse(`响应数据与契约不符：${formatIssues(parsed.error.issues)}`, res.status, parsed.error.issues);
  }
  return parsed.data;
}

/** Validate input, send, parse. Works for any EndpointDef (not only `Api`). */
export async function send(def: EndpointDef, input: unknown, opts: CallOptions, fetchImpl: FetchLike): Promise<unknown> {
  let body: string | undefined;
  if (def.input) {
    const parsed = def.input.safeParse(input);
    if (!parsed.success) {
      throw new ApiClientError({
        code: 'VALIDATION_ERROR',
        message: formatIssues(parsed.error.issues),
        status: 0,
        retryable: false,
        details: parsed.error.issues,
      });
    }
    body = JSON.stringify(parsed.data);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // S4a: lets the change feed tell this tab its own writes apart from a second tab's
  if (requestTab) headers['X-SSM-Tab'] = requestTab;

  let res: Response;
  try {
    res = await fetchImpl(fillPath(def.path, opts.params), {
      method: def.method,
      credentials: 'same-origin',
      headers,
      body,
      signal: opts.signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiClientError({ code: 'NETWORK_ERROR', message: '无法连接本地服务', status: 0, retryable: true, cause: e });
  }
  return parseResponse(res, def.output);
}

export function createApiClient(fetchImpl: FetchLike = (input, init) => fetch(input, init)): ApiClient {
  return {
    call(name, ...args) {
      const def: EndpointDef = Api[name];
      const [input, opts] = args;
      return send(def, input, opts ?? {}, fetchImpl) as Promise<never>;
    },
  };
}

/** Shared client for the app. */
export const api: ApiClient = createApiClient();
