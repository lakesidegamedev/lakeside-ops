"use strict";
// Keir 11.1: ticket-only replies, broker side.
//
// After a broker-verified on-ticket reporter_operating_results or
// reporter_action_points read, replies on that ticket must reach the reporter's
// channel without the public receipt showing their text. The support server
// narrows when support_public_update carries ticket_only: true. A support
// server without the field would drop it silently (unknown keys are stripped)
// and publish the answer, so the broker checks the advertised schema first and
// refuses to send when the option is missing.

const PRIVATE_REPORTER_TOOLS = new Set(["reporter_operating_results", "reporter_action_points"]);

const isPrivateReporterRead = (server, tool) => server === "gamestate" && PRIVATE_REPORTER_TOOLS.has(tool);

// tools: the support server's tools/list result (mcp.list("support")).
function supportsTicketOnly(tools, name = "support_public_update") {
  const tool = (tools || []).find((t) => t && t.name === name);
  return Boolean(tool && tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.ticket_only);
}

// Returns args with the narrowing flag, or throws so nothing is delivered.
function narrowedArgs(args, tools, name = "support_public_update") {
  if (!supportsTicketOnly(tools, name)) throw new Error("The support server cannot keep this answer off the public receipt yet, so it was not sent. Do not restate the figures elsewhere; finish without posting and note the answer for staff.");
  return { ...args, ticket_only: true };
}

module.exports = { PRIVATE_REPORTER_TOOLS, isPrivateReporterRead, supportsTicketOnly, narrowedArgs };
