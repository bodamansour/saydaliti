// Suggest mapping.json from schema.json:  node scripts/suggest-mapping.js connector/schema.json > connector/mapping.json
import { readFileSync } from 'node:fs';
import { suggestMapping } from '../src/mapping.js';
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/suggest-mapping.js schema.json'); process.exit(1); }
const { mapping, summary, notes } = suggestMapping(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
console.error(JSON.stringify(summary, null, 1)); notes.forEach((n) => console.error('- ' + n));
console.log(JSON.stringify(mapping, null, 2));
