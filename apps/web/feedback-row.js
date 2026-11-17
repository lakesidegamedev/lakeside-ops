"use strict";
// The answer feedback row Keir puts under its answers. Player replies posted by the
// support service carry the identical row; Keir's interaction handler records clicks on
// them (see adoptSupportReply in apps/agent/lib/operator/feedback.js). This file is a
// dependency-free copy because the web service does not ship apps/agent; a test in
// apps/agent/test keeps the two identical.
const PREFIX = "keir_fb:";

function row() {
  return [{ type: 1, components: [
    { type: 2, style: 2, emoji: { name: "⭐" }, custom_id: `${PREFIX}great` },
    { type: 2, style: 2, emoji: { name: "👍" }, custom_id: `${PREFIX}up` },
    { type: 2, style: 2, emoji: { name: "👎" }, custom_id: `${PREFIX}down` },
    { type: 2, style: 2, label: "Report a problem", custom_id: `${PREFIX}report` },
  ] }];
}

module.exports = { row, PREFIX };
