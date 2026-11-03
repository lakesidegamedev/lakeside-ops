"use strict";
// Canonical names for the repository transfer; stored legacy receipts stay valid.
const GITHUB_OWNER = "lakesidegamedev";
function canonicalRepository(repository) {
  return String(repository).replace(/^(?:Egg3901|lakesidegamedev)\/(AHDGame|AHDClient|lakeside-operator|lakeside-ops)$/, `${GITHUB_OWNER}/$1`);
}
function canonicalGithubUrl(url) {
  return String(url).replace(/^https:\/\/github\.com\/((?:Egg3901|lakesidegamedev)\/(?:AHDGame|AHDClient|lakeside-operator|lakeside-ops))\//, (_, repository) => `https://github.com/${canonicalRepository(repository)}/`);
}
function repositoryName(name) {
  // A logical Keir source name targets the monorepo for new work. Existing
  // receipt URLs retain their repository identity and original PR numbers.
  return `${GITHUB_OWNER}/${name === "lakeside-operator" ? "lakeside-ops" : name}`;
}
const GAME_REPO = `${GITHUB_OWNER}/AHDGame`;
const CI_REPOSITORIES = [GAME_REPO, repositoryName("AHDClient")];
function pullRequestNumber(name, url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(String(url));
  return match && canonicalRepository(match[1]) === repositoryName(name) ? Number(match[2]) : 0;
}
// A check cancelled by a newer run of the same check (workflow concurrency) is superseded,
// not failed. Ticket 1758 (2026-11-03): custom-rules ran twice for one push, the older run was
// cancelled, the newer passed, and the CI watch woke the task 12 times in an hour on "failed".
function redChecks(runs) {
  return (runs || []).filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion)
    && !(r.conclusion === "cancelled" && runs.some((o) => o !== r && o.name === r.name && o.conclusion !== "cancelled")));
}
module.exports = { redChecks, GITHUB_OWNER, GAME_REPO, CI_REPOSITORIES, canonicalRepository, canonicalGithubUrl, repositoryName, pullRequestNumber };
