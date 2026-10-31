import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

type D1PreparedStatement = {
  bind(...values: string[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success?: boolean;
    error?: string;
  }>;
};

type D1DatabaseBinding = {
  prepare(sql: string): D1PreparedStatement;
};

type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  ARTICLES_WRITE_TOKEN?: string;
};

const MAX_RESULTS = 50;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
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
    return jsonResponse({ ok: false, error: 'Article queue is not configured.' }, 503);
  }

  if (request.headers.get('authorization') !== `Bearer ${expectedToken}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401);
  }

  if (!runtimeEnv.DB) {
    return jsonResponse({ ok: false, error: 'D1 database binding is not configured.' }, 503);
  }

  try {
    const result = await runtimeEnv.DB
      .prepare(
        'SELECT id, status, review_status FROM articles WHERE status = ? AND review_status = ? ORDER BY id ASC LIMIT ?'
      )
      .bind('draft', 'approved', MAX_RESULTS)
      .all<{ id: string; status: string; review_status: string }>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 query failed.');
    }

    return jsonResponse({ articles: result.results ?? [] });
  } catch (error) {
    console.error('D1 approved draft queue lookup failed.', error);
    return jsonResponse({ ok: false, error: 'Unable to load articles ready to publish.' }, 500);
  }
};
