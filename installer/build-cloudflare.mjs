import { readFileSync, writeFileSync } from 'node:fs';
// Text-only, reproducible bundle; no secret environment variables are read.
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
writeFileSync(new URL('./schema-bundle.mjs', import.meta.url), `// Generated from supabase/schema.sql. Do not edit.\nexport default ${JSON.stringify(schema)};\n`);
