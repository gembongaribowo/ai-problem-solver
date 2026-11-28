import { env } from 'cloudflare:workers';
import type { ArticleRuntimeEnv } from '../lib/articles';

export const prerender = false;

const SITE_URL = 'https://aiproductimpact.com';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<Response> {
  const runtimeEnv = env as unknown as ArticleRuntimeEnv;

  if (
    !runtimeEnv.DB ||
    runtimeEnv.ARTICLES_DATA_SOURCE !== 'd1' ||
    runtimeEnv.ARTICLES_D1_READY !== 'true'
  ) {
    return new Response('Sitemap temporarily unavailable.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  try {
    const result = await runtimeEnv.DB
      .prepare(
        `SELECT slug, published_at
         FROM articles
         WHERE status = ? AND slug IS NOT NULL AND slug != ''
         ORDER BY published_at DESC, id ASC`
      )
      .bind('published')
      .all<{ slug: string; published_at: string | null }>();

    if (result.success === false) {
      throw new Error(result.error || 'D1 sitemap query failed.');
    }

    const articleUrls = (result.results ?? []).map((article) => {
      const loc = `${SITE_URL}/${encodeURIComponent(article.slug)}`;
      const parsedDate = article.published_at ? new Date(article.published_at) : null;
      const lastmod =
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? `\n    <lastmod>${parsedDate.toISOString()}</lastmod>`
          : '';

      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod}\n  </url>`;
    });

    const urls = [
      `  <url>\n    <loc>${SITE_URL}/</loc>\n  </url>`,
      ...articleUrls,
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Sitemap generation failed.', error);
    return new Response('Sitemap temporarily unavailable.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
