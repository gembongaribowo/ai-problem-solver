import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

type D1PreparedStatement = {
  bind(...values: string[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

type D1DatabaseBinding = {
  prepare(sql: string): D1PreparedStatement;
};

type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_WRITE_TOKEN?: string;
};

const MAX_URLS = 500;
const MAX_URL_LENGTH = 4096;
const MAX_BODY_BYTES = 256 * 1024;
const D1_PARAMETER_CHUNK_SIZE = 100;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH || value.trim() !== value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const expectedToken = runtimeEnv.ARTICLES_WRITE_TOKEN;

  if (!expectedToken) {
    return jsonResponse({ ok: false, error: 'Article lookup is not configured.' }, 503);
  }

  if (request.headers.get('authorization') !== `Bearer ${expectedToken}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
  }

  if (!runtimeEnv.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is not configured.' }, 503);
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: 'Request body is too large.' }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ ok: false, error: 'Unable to read request body.' }, 400);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: 'Request body is too large.' }, 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: 'Request body must be valid JSON.' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ ok: false, error: 'Request body must be a JSON object.' }, 400);
  }

  const sourceUrls = (payload as { source_urls?: unknown }).source_urls;
  if (!Array.isArray(sourceUrls) || sourceUrls.length > MAX_URLS) {
    return jsonResponse(
      { ok: false, error: `source_urls must be an array of at most ${MAX_URLS} URLs.` },
      400
    );
  }

  if (!sourceUrls.every((value): value is string => typeof value === 'string' && isHttpUrl(value))) {
    return jsonResponse(
      { ok: false, error: 'Every source_urls item must be a valid HTTP or HTTPS URL of at most 4096 characters.' },
      400
    );
  }

  // Query unique values only, but retain every original input (and its order) in the response.
  const uniqueUrls = [...new Set(sourceUrls)];
  const existingUrls = new Set<string>();

  try {
    for (let offset = 0; offset < uniqueUrls.length; offset += D1_PARAMETER_CHUNK_SIZE) {
      const chunk = uniqueUrls.slice(offset, offset + D1_PARAMETER_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await runtimeEnv.DB
        .prepare(`SELECT source_url FROM articles WHERE source_url IN (${placeholders})`)
        .bind(...chunk)
        .all<{ source_url: string }>();

      for (const row of result.results) {
        existingUrls.add(row.source_url);
      }
    }

    return jsonResponse({
      results: sourceUrls.map((source_url) => ({
        source_url,
        exists: existingUrls.has(source_url),
      })),
    });
  } catch (error) {
    console.error('D1 batch article existence check failed.', error);
    return jsonResponse({ ok: false, error: 'Unable to check article existence.' }, 500);
  }
};
