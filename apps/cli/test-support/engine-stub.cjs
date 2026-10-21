"use strict";
const fs = require("node:fs");
const path = require("node:path");

function writeEngineStub(dir, name, body) {
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(script, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  if (process.platform !== "win32") return script;
  const launcher = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
  return launcher;
}

module.exports = { writeEngineStub };
