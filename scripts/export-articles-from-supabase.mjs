import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.PUBLIC_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY.'
  );
}

const supabase = createClient(supabaseUrl, supabaseKey, {
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

  if (error) throw new Error(`Supabase export failed at offset ${offset}: ${error.message}`);

  articles.push(...(data ?? []));
  if (!data || data.length < pageSize) break;
}

const outputPath = resolve(process.argv[2] ?? '.migration-data/articles.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(articles, null, 2), 'utf8');

console.log(`Exported ${articles.length} articles to ${outputPath}.`);
console.log('Keep this export private and do not commit it to Git.');
