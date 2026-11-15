'use strict';
// Shared helper for the k10 scenario tests: a started env and a tool shortcut.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { createEnv } = require('./env.cjs');
function start(sc, over = {}) {
  const env = createEnv({ scenario: sc, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'k10-')), ...over });
  env.job.state = 'running';
  const t = (name, input) => env.broker.tool(env.job, name, input);
  // Like the runner: the player writes, the next activation starts.
  const player = (text) => { env.playerReply(text); env.job.state = 'running'; };
  return { env, t, player };
}
module.exports = { start };
