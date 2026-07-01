const ALLOWED_HOSTS = new Set([
  'platform.justincourse.com',
  'dev.platform.justincourse.com',
  'app.justincourse.com',
  'web.justincourse.com',
  'dev.justincourse.com',
  'justincourse.com',
  'interjc.net',
]);

const CORP = 'same-site';
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24;
const CACHEABLE_STATUS = 200;

type WorkerEnv = Omit<Env, 'CACHE_TTL_SECONDS' | 'EDGE_CACHE_ENABLED'> & {
  MEDIA: R2Bucket;
  CACHE_TTL_SECONDS?: number | string;
  EDGE_CACHE_ENABLED?: boolean | string;
};

type AccessContext = {
  origin: string;
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'request failed',
        error: error instanceof Error ? error.message : String(error),
        path: safePathname(request.url),
      }));

      return new Response('internal error', { status: 500 });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const access = getAccessContext(request);

  if (request.method === 'OPTIONS') {
    if (!access) {
      return new Response('blocked', { status: 403 });
    }

    return new Response(null, {
      status: 204,
      headers: withAccessHeaders(new Headers({
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Max-Age': '86400',
      }), access),
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  if (!access) {
    return new Response('blocked', { status: 403 });
  }

  const key = getObjectKey(request.url);
  if (!key) {
    return new Response('bad request', { status: 400 });
  }

  const cacheEnabled = isEdgeCacheEnabled(env.EDGE_CACHE_ENABLED);
  const cacheTtl = positiveInt(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cacheKey = createCacheKeyRequest(request, key, true);

  if (cacheEnabled) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return finalizeResponse(cached, access, request.method === 'HEAD', 'HIT');
    }
  }

  if (request.method === 'HEAD') {
    const obj = await env.MEDIA.head(key);
    if (!obj) {
      return new Response('404', { status: 404 });
    }

    const headers = objectHeaders(obj, cacheTtl);
    headers.set('Content-Length', String(obj.size));
    return finalizeResponse(new Response(null, { headers }), access, true, 'BYPASS');
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader && !isSingleBytesRange(rangeHeader)) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: withAccessHeaders(new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes */*',
      }), access),
    });
  }

  const obj = await env.MEDIA.get(
    key,
    rangeHeader ? { range: new Headers({ Range: rangeHeader }) } : undefined,
  );
  if (!obj) {
    return new Response('404', { status: 404 });
  }

  const headers = objectHeaders(obj, cacheTtl);
  let status = CACHEABLE_STATUS;

  if (rangeHeader) {
    const range = resolveReturnedRange(obj) ?? resolveRequestedRange(rangeHeader, obj.size);
    if (!range) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: withAccessHeaders(new Headers({
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${obj.size}`,
        }), access),
      });
    }

    status = 206;
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${obj.size}`);
    headers.set('Content-Length', String(range.length));
  } else {
    headers.set('Content-Length', String(obj.size));
  }

  const originResponse = new Response(obj.body, { status, headers });

  if (cacheEnabled && status === CACHEABLE_STATUS && cacheTtl > 0) {
    const cacheWriteKey = createCacheKeyRequest(request, key, false);
    ctx.waitUntil(cache.put(cacheWriteKey, originResponse.clone()).catch((error) => {
      console.warn(JSON.stringify({
        message: 'edge cache put failed',
        error: error instanceof Error ? error.message : String(error),
        key,
      }));
    }));
  }

  return finalizeResponse(originResponse, access, false, cacheEnabled ? 'MISS' : 'BYPASS');
}

function getAccessContext(request: Request): AccessContext | null {
  const origin = parseUrl(request.headers.get('Origin'));
  if (origin && ALLOWED_HOSTS.has(origin.hostname)) {
    return { origin: origin.origin };
  }

  const referer = parseUrl(request.headers.get('Referer'));
  if (referer && ALLOWED_HOSTS.has(referer.hostname)) {
    return { origin: referer.origin };
  }

  return null;
}

function getObjectKey(requestUrl: string): string | null {
  const url = parseUrl(requestUrl);
  if (!url) {
    return null;
  }

  const rawKey = url.pathname.replace(/^\/+/, '');
  if (!rawKey) {
    return null;
  }

  try {
    return decodeURIComponent(rawKey);
  } catch {
    return null;
  }
}

function createCacheKeyRequest(request: Request, key: string, includeRange: boolean): Request {
  const url = new URL(request.url);
  url.pathname = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  url.search = '';

  const headers = new Headers();

  if (includeRange) {
    const range = request.headers.get('Range');
    if (range) {
      headers.set('Range', range);
    }
  }

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch) {
    headers.set('If-None-Match', ifNoneMatch);
  }

  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (ifModifiedSince) {
    headers.set('If-Modified-Since', ifModifiedSince);
  }

  return new Request(url.toString(), { method: 'GET', headers });
}

function objectHeaders(obj: R2Object, cacheTtl: number): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);

  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }

  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', obj.httpEtag);
  headers.set('Last-Modified', obj.uploaded.toUTCString());

  if (!headers.has('Cache-Control') && cacheTtl > 0) {
    headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
  }

  return headers;
}

function withAccessHeaders(headers: Headers, access: AccessContext): Headers {
  headers.set('Cross-Origin-Resource-Policy', CORP);
  headers.set('Access-Control-Allow-Origin', access.origin);
  headers.set('Access-Control-Expose-Headers', [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'ETag',
    'Last-Modified',
    'X-Edge-Cache',
  ].join(', '));
  headers.append('Vary', 'Origin');

  return headers;
}

function finalizeResponse(
  response: Response,
  access: AccessContext,
  headOnly: boolean,
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS',
): Response {
  const headers = withAccessHeaders(new Headers(response.headers), access);
  headers.set('X-Edge-Cache', cacheStatus);

  return new Response(headOnly ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveReturnedRange(obj: R2ObjectBody): { start: number; end: number; length: number } | null {
  if (!obj.range) {
    return null;
  }

  if ('suffix' in obj.range) {
    const length = Math.min(obj.range.suffix, obj.size);
    const start = obj.size - length;
    return { start, end: obj.size - 1, length };
  }

  const start = obj.range.offset ?? 0;
  const length = obj.range.length ?? (obj.size - start);
  const end = start + length - 1;

  if (start < 0 || length <= 0 || end >= obj.size) {
    return null;
  }

  return { start, end, length };
}

function resolveRequestedRange(
  rangeHeader: string,
  size: number,
): { start: number; end: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || size <= 0) {
    return null;
  }

  const [, rawStart, rawEnd] = match;

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    const length = Math.min(suffixLength, size);
    const start = size - length;
    return { start, end: size - 1, length };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) {
    return null;
  }

  const end = rawEnd ? Math.min(Number.parseInt(rawEnd, 10), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  return { start, end, length: end - start + 1 };
}

function isSingleBytesRange(rangeHeader: string): boolean {
  return /^bytes=(?:\d+-\d*|\d*-\d+)$/.test(rangeHeader);
}

function isEdgeCacheEnabled(value: boolean | string | undefined): boolean {
  return value !== false && value !== 'false';
}

function positiveInt(value: number | string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safePathname(value: string): string {
  return parseUrl(value)?.pathname ?? '';
}
