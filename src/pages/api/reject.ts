import type { APIRoute } from 'astro';
import { updateArticleReviewStatus } from '../../lib/article-mutations';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

export const GET: APIRoute = async ({ url }) => {
  const articleId = url.searchParams.get('id');
  if (!articleId) {
    return new Response(JSON.stringify({ error: 'Missing article ID' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const result = await updateArticleReviewStatus(articleId, 'rejected');
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(
    `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Article Rejected</title></head>
      <body>
        <h1>❌ Article Rejected</h1>
        <p>The article has been rejected successfully.</p>
        <p><strong>${escapeHtml(result.article.title)}</strong></p>
        <p>Review status: rejected</p>
      </body>
    </html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
};
