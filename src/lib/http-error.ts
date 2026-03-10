import { redactSecrets, sanitizeHeaders } from './secrets.js';

export interface HttpErrorInit {
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders?: HeadersInit;
  responseBody?: string;
  secretValues?: unknown;
  bodyLimit?: number;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated]`;
}

function buildMessage(init: HttpErrorInit): string {
  const method = String(init.method || 'GET').toUpperCase();
  const url = redactSecrets(init.url, init.secretValues);
  const status = `${init.status}${init.statusText ? ` ${init.statusText}` : ''}`;
  const responseBody = truncate(
    redactSecrets(init.responseBody || '', init.secretValues),
    Math.max(0, init.bodyLimit ?? 800)
  );
  return responseBody
    ? `${method} ${url} failed: ${status} - ${responseBody}`
    : `${method} ${url} failed: ${status}`;
}

export class HttpError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(init: HttpErrorInit) {
    super(buildMessage(init));
    this.name = 'HttpError';
    this.status = init.status;
    this.responseBody = init.responseBody || '';
  }

  static async fromResponse(
    response: Response,
    init: Omit<HttpErrorInit, 'status' | 'statusText' | 'responseBody'> & {
      responseBody?: string;
    }
  ): Promise<HttpError> {
    const responseBody =
      init.responseBody ?? (await response.text().catch(() => ''));
    return new HttpError({
      ...init,
      status: response.status,
      statusText: response.statusText,
      responseBody
    });
  }
}
