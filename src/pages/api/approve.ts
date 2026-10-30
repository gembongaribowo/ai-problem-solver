import type { APIRoute } from 'astro';
import { updateArticleReviewStatus } from '../../lib/article-mutations';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const articleId = url.searchParams.get('id');
  if (!articleId) return new Response('Missing article ID', { status: 400 });

  const result = await updateArticleReviewStatus(articleId, 'approved');
  if (!result.ok) return new Response(result.error, { status: result.status });

  return new Response(
    `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Article Approved</title></head>
      <body>
        <h1>✅ Article Approved</h1>
        <p>The article has been approved successfully.</p>
        <p>You can close this page.</p>
      </body>
    </html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
};
