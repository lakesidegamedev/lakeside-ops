"use strict";
// Keir 11.2: AHDGame's required custom-rules check fails any PR whose description lacks the "Conflict of interest"
// section. Five Keir PRs (6784, 6791, 6798, 6799, 6878) sat red for days because the model left it out; only doc review
// PRs had it added. Code adds it to every PR Keir opens or edits, of every kind, and never relies on the model.
const DISCLOSURE = "\n\n## Conflict of interest\n\n- [x] This change does not directly affect a character, corporation, or other in-game holding of mine\n- [ ] It does, and I have disclosed it below or privately to a maintainer";

function hasDisclosure(body) { return /^#{1,6}\s*Conflict of interest\s*$/im.test(String(body || "")); }
function withDisclosure(body) {
  const text = String(body || "");
  return hasDisclosure(text) ? text : `${text.trimEnd()}${DISCLOSURE}`;
}

module.exports = { DISCLOSURE, hasDisclosure, withDisclosure };
