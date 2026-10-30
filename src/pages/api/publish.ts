import type { APIRoute } from 'astro';
import { publishArticle } from '../../lib/article-mutations';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
  }

  const articleId = typeof body.id === 'string' ? body.id : '';
  if (!articleId) return jsonResponse({ error: 'Missing article ID.' }, 400);

  const result = await publishArticle(articleId);
  if (!result.ok) return jsonResponse({ error: result.error, articleId }, result.status);

  return jsonResponse({
    success: true,
    message: 'Article published successfully.',
    article: result.article,
  });
};
