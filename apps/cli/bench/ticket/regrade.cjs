'use strict';
// Re-grade saved simulations from world.json with the current rubric.
const fs = require('node:fs'), path = require('node:path'), { grade } = require('./grade.cjs');
const out = process.argv[2]; let n = 0;
for (const d of fs.readdirSync(out)) {
  const w = path.join(out, d, 'world.json'), r = path.join(out, d, 'result.json');
  if (!fs.existsSync(w) || !fs.existsSync(r)) continue;
  const result = JSON.parse(fs.readFileSync(r)), g = grade(JSON.parse(fs.readFileSync(w)));
  if (JSON.stringify(g) !== JSON.stringify(result.grade)) { result.gradeHistory = [...(result.gradeHistory || []), result.grade]; result.grade = g; fs.writeFileSync(r, JSON.stringify(result, null, 2)); n++; }
}
console.log('regraded', n);
