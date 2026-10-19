#!/usr/bin/env node
"use strict";
async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(a => !["--preview", "--status"].includes(a)) || args.length > 1) throw new Error("Usage: keir-audit [--preview | --status]");
  if (!env.KEIR_OPERATOR_ADMIN_TOKEN) throw new Error("KEIR_OPERATOR_ADMIN_TOKEN is required");
  const url = env.KEIR_OPERATOR_URL || "http://127.0.0.1:9765";
  const response = await fetch(`${url}/v5/accounts/audit`, { method: args[0] === "--status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${env.KEIR_OPERATOR_ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: args[0] === "--status" ? undefined : JSON.stringify({ dryRun: args[0] === "--preview" }), signal: AbortSignal.timeout(660000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Audit returned ${response.status}`);
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
