// Print the WhatsApp morning report from a connector export:
//   node scripts/morning.js connector/data.json "صيدلية أحمد منصور"
import { readFileSync } from 'node:fs';
import { fromExport, analyze } from '../src/core.js';
import { morningReport } from '../src/report.js';

const [file, name] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/morning.js data.json [pharmacy name]'); process.exit(1); }
const raw = readFileSync(file, 'utf8').replace(/^﻿/, ''); // PowerShell writes a BOM
const A = analyze(fromExport(JSON.parse(raw)));
console.log(morningReport(A, { pharmacyName: name || 'الصيدلية' }));
