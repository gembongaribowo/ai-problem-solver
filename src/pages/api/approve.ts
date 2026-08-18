import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const articleId = url.searchParams.get('id');

  if (!articleId) {
    return new Response('Missing article ID', {
      status: 400,
    });
  }

  const supabase = createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Only approve articles that are currently pending
  const { data, error } = await supabase
    .from('articles')
    .update({
      review_status: 'approved',
    })
    .eq('id', articleId)
    .eq('review_status', 'pending')
    .select('id, title, review_status');

  if (error) {
    console.error(error);

    return new Response('Failed to approve article', {
      status: 500,
    });
  }

  if (!data || data.length === 0) {
    return new Response(
      'Article not found or has already been reviewed',
      {
        status: 404,
      }
    );
  }

  return new Response(
    `
      <html>
        <body>
          <h1>✅ Article Approved</h1>
          <p>The article has been approved successfully.</p>
          <p>You can close this page.</p>
        </body>
      </html>
    `,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
      },
    }
  );
};