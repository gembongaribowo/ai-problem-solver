import { env } from 'cloudflare:workers';
import { listPublishedArticles, type ArticleRuntimeEnv } from '../lib/articles';

export const prerender = false;

const SITE_URL = 'https://aiproductimpact.com';
const FEED_URL = `${SITE_URL}/rss.xml`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function GET(): Promise<Response> {
  const runtimeEnv = env as unknown as ArticleRuntimeEnv;
  const { data, error } = await listPublishedArticles(runtimeEnv);

  if (error) {
    return new Response('RSS feed temporarily unavailable.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '60',
      },
    });
  }

  const items = data
    .filter((article) => typeof article.slug === 'string' && article.slug.trim().length > 0)
    .map((article) => {
      const slug = article.slug!.trim();
      const url = `${SITE_URL}/${encodeURIComponent(slug)}`;
      const title = asText(article.title) || asText(article.source_title) || 'AI Product Update';
      const description = asText(article.summary) || asText(article.why_it_matters) || title;
      const publishedAt = article.published_at || article.source_published_at;
      const parsedDate = publishedAt ? new Date(publishedAt) : null;
      const pubDate = parsedDate && !Number.isNaN(parsedDate.getTime())
        ? `\n      <pubDate>${parsedDate.toUTCString()}</pubDate>`
        : '';
      const category = asText(article.category)
        ? `\n      <category>${escapeXml(asText(article.category))}</category>`
        : '';

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <description>${escapeXml(description)}</description>${pubDate}${category}
    </item>`;
    });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>AI Product Impact</title>
    <link>${SITE_URL}/</link>
    <description>Practical AI product launches, adoption stories, and measurable impact — summarized for product teams.</description>
    <language>en</language>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom" />
${items.join('\n')}
  </channel>
</rss>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
