import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const GET: APIRoute = async ({ url }) => {
  const articleId = url.searchParams.get('id');

  if (!articleId) {
    return new Response(
      JSON.stringify({
        error: 'Missing article ID',
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const supabase = createClient(
    import.meta.env.SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('articles')
    .update({
      review_status: 'rejected',
    })
    .eq('id', articleId)
    .eq('review_status', 'pending')
    .select('id, title, review_status')
    .single();

  if (error || !data) {
    return new Response(
      JSON.stringify({
        error: 'Article not found or has already been reviewed',
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  return new Response(
    `
      <html>
        <head>
          <title>Article Rejected</title>
        </head>
        <body>
          <h1>❌ Article Rejected</h1>
          <p>The article has been rejected successfully.</p>
          <p><strong>${data.title}</strong></p>
          <p>Review status: ${data.review_status}</p>
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