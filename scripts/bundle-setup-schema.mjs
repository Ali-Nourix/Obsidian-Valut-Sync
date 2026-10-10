import { readFileSync, writeFileSync } from 'node:fs';
const schema = readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8');
writeFileSync(new URL('../src/onboarding/schema.ts',import.meta.url), `// Generated from supabase/schema.sql; contains no credentials.\nexport const SETUP_SCHEMA = ${JSON.stringify(schema)};\n`);
