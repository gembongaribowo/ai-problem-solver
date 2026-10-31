import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

type SqlValue = string | number | null;

type D1PreparedStatement = {
  bind(...values: SqlValue[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
};

type D1DatabaseBinding = {
  prepare(sql: string): D1PreparedStatement;
};

type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_WRITE_TOKEN?: string;
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const expectedToken = runtimeEnv.ARTICLES_WRITE_TOKEN;

  if (!expectedToken) {
    return jsonResponse(
      { ok: false, error: 'Article lookup is not configured.' },
      503
    );
  }

  if (
    request.headers.get('authorization') !==
    `Bearer ${expectedToken}`
  ) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
  }

  if (!runtimeEnv.DB) {
    return jsonResponse(
      { ok: false, error: 'D1 database binding is not configured.' },
      503
    );
  }

  const sourceUrl = new URL(request.url).searchParams.get('source_url');

  if (!sourceUrl || !sourceUrl.trim()) {
    return jsonResponse(
      { ok: false, error: 'source_url is required.' },
      400
    );
  }

  if (sourceUrl.length > 4096) {
    return jsonResponse(
      { ok: false, error: 'source_url is too long.' },
      400
    );
  }

  try {
    const parsedUrl = new URL(sourceUrl);

    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
      !parsedUrl.hostname
    ) {
      return jsonResponse(
        { ok: false, error: 'source_url must be a valid HTTP or HTTPS URL.' },
        400
      );
    }
  } catch {
    return jsonResponse(
      { ok: false, error: 'source_url must be a valid HTTP or HTTPS URL.' },
      400
    );
  }

  try {
    const existing = await runtimeEnv.DB
      .prepare(
        'SELECT source_url FROM articles WHERE source_url = ? LIMIT 1'
      )
      .bind(sourceUrl)
      .first<{ source_url: string }>();

    if (existing) {
      return jsonResponse({
        exists: true,
        source_url: existing.source_url,
      });
    }

    return jsonResponse({ exists: false });
  } catch (error) {
    console.error('D1 article existence check failed.', error);

    return jsonResponse(
      { ok: false, error: 'Unable to check article existence.' },
      500
    );
  }
};
