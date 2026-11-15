'use strict';
// Loaded before anything requires the broker. The broker launches a few host
// actions through child_process.execFile directly (systemd-run for the deps
// refresh, systemctl for host actions); in a replay those must never reach the
// host. They are recorded and refused instead.
const cp = require('node:child_process');
const BLOCK = /(?:^|\/)(?:systemd-run|systemctl|sudo|railway)$/;
const blocked = [];
const original = cp.execFile;
cp.execFile = function (file, args, options, callback) {
  if (BLOCK.test(String(file))) {
    blocked.push({ file, args: Array.isArray(args) ? args.slice(0, 12) : [], at: Date.now() });
    const cb = [args, options, callback].find((x) => typeof x === 'function');
    if (cb) setImmediate(() => cb(new Error('blocked in replay'), '', ''));
    return { pid: 0, kill() {}, on() {}, stdout: null, stderr: null };
  }
  return original.apply(this, arguments);
};
module.exports = { blocked };
