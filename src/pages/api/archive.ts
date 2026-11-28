import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listHomepageArchiveArticles, type ArticleRuntimeEnv, type HomepageArchiveCursor } from '../../lib/articles';

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getArchiveBoundary(): string {
  const yesterdayKey = dateKeyFormatter.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  return new Date(`${yesterdayKey}T00:00:00+07:00`).toISOString();
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=15, s-maxage=30',
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const limitValue = Number(url.searchParams.get('limit') || 9);
  const limit = Number.isFinite(limitValue) ? Math.min(30, Math.max(1, Math.floor(limitValue))) : 9;
  const category = url.searchParams.get('category')?.trim().slice(0, 80) || undefined;
  const search = url.searchParams.get('q')?.trim().slice(0, 100) || undefined;
  const cursorPublishedAt = url.searchParams.get('cursor_published_at');
  const cursorId = url.searchParams.get('cursor_id');
  const cursor: HomepageArchiveCursor | null = cursorPublishedAt && cursorId
    ? { published_at: cursorPublishedAt.slice(0, 64), id: cursorId.slice(0, 128) }
    : null;

  const runtimeEnv = env as unknown as ArticleRuntimeEnv;
  const result = await listHomepageArchiveArticles(
    runtimeEnv,
    getArchiveBoundary(),
    limit,
    cursor,
    category,
    search
  );

  if (result.error) {
    return jsonResponse({ ok: false, error: 'Unable to load archive updates.' }, 503);
  }

  return jsonResponse({
    ok: true,
    articles: result.data,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  });
};
