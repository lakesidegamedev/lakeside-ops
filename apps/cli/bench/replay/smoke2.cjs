'use strict';
require('./guard.cjs');
const { createEnv } = require('./env.cjs');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
(async () => {
  const sc = { ...require('./scenarios/dev/wage-desktop.cjs'), dir: require('node:path').join(__dirname, 'scenarios', 'dev') };
  const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'replay2-')) });
  const { broker, job } = env; job.state = 'running';
  const step = async (name, input) => { try { const r = await broker.tool(job, name, input); console.log('OK  ', name, JSON.stringify(r).slice(0, 220)); } catch (e) { console.log('ERR ', name, e.message.slice(0, 260)); } };
  await step('repository_snapshot', { repository: 'AHDGame', ref: 'main' });
  await step('shell', { command: 'cd repo && ls src/lib/labour && grep -n "offeredWage = null" -r src' });
  await step('evidence_batch', { queries: [{ op: 'read', path: 'src/app/wageForm.desktop.ts' }] });
  console.log('blocked host actions:', require('./guard.cjs').blocked);
})();
