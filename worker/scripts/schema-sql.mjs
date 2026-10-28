// Writes migrations/0001_init.sql from src/schema.js (the one list of tables).
import { writeFile } from 'node:fs/promises';
import { schemaSql } from '../src/schema.js';
await writeFile(new URL('../migrations/0001_init.sql', import.meta.url), `-- Generated from src/schema.js by scripts/schema-sql.mjs. Do not edit by hand.\n${schemaSql()}\n`);
console.log('migrations/0001_init.sql written');
