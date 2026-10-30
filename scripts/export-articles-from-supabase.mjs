import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    'Set SUPABASE_URL (or PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY. A service-role key is required for a complete export.'
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const pageSize = 250;
const articles = [];

for (let offset = 0; ; offset += pageSize) {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('id', { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (error) {
    throw new Error(`Supabase export failed at offset ${offset}: ${error.message}`);
  }

  articles.push(...(data ?? []));
  if (!data || data.length < pageSize) break;
}

const ids = new Set();
const sourceUrls = new Set();
for (const article of articles) {
  if (!article.id) throw new Error('Export contains an article without an id.');
  if (!article.source_url) throw new Error(`Article ${article.id} has no source_url.`);
  if (ids.has(article.id)) throw new Error(`Duplicate article id in export: ${article.id}`);
  if (sourceUrls.has(article.source_url)) {
    throw new Error(`Duplicate source_url in export: ${article.source_url}`);
  }
  ids.add(article.id);
  sourceUrls.add(article.source_url);
}

const published = articles.filter((article) => article.status === 'published').length;
const drafts = articles.length - published;
const slugCounts = new Map();
for (const article of articles) {
  if (article.slug) slugCounts.set(article.slug, (slugCounts.get(article.slug) ?? 0) + 1);
}
const duplicateSlugs = [...slugCounts.entries()].filter(([, count]) => count > 1);

const outputPath = resolve(process.argv[2] ?? '.migration-data/articles.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(articles, null, 2), 'utf8');

console.log(`Exported ${articles.length} articles (${published} published, ${drafts} not published) to ${outputPath}.`);
console.log(`Unique IDs: ${ids.size}; unique source URLs: ${sourceUrls.size}.`);
if (duplicateSlugs.length) {
  console.warn('Duplicate slugs need review before cutover:');
  for (const [slug, count] of duplicateSlugs) console.warn(`  ${count} records: ${slug}`);
}
console.log('Keep this export private and do not commit it to Git.');
