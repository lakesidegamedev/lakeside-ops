#!/usr/bin/env node
"use strict";
// Flip Keir's kill switch without a deploy: on [reason...] | off | status.
const { createKillSwitch } = require("../lib/operator/killswitch");
const ks = createKillSwitch({ ttlMs: 0 });
const [verb = "status", ...rest] = process.argv.slice(2);
if (verb === "on") console.log(JSON.stringify(ks.engage({ reason: rest.join(" ") || "engaged by the owner", by: process.env.SUDO_USER || process.env.USER || "owner" })));
else if (verb === "off") console.log(JSON.stringify(ks.release()));
else if (verb === "status") console.log(JSON.stringify(ks.state()));
else { console.error("usage: keir-killswitch.js on [reason] | off | status"); process.exit(2); }
