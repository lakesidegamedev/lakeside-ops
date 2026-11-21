"use strict";
// Keir 11.2 fourth pass: reading GitHub lists at the size of the real repository.
//
// Run against a copy of production state, the preview report printed "GitHub repos/lakesidegamedev/AHDGame/pulls: stdout
// maxBuffer length exceeded" and "keirprs: open sweep skipped". The live open-PR pass used the same read: one page of 100
// full pull request objects (bodies, every nested user and repo) through a gh child process with Node's default 1 MiB
// buffer. The repository has dozens of open pull requests and thousands of closed ones.
//
// Now every gh child gets a large buffer (ghApi), lists are paged and ask only for the fields used (listAll with a jq
// projection), and a list that cannot be read in full is an explicit error, never an empty or partial list:
//   - a page that is not an array: ListReadError "could not read";
//   - more pages than allowed for a list that must be complete: ListReadError "truncated".
// A "window" list (the most recent N, by design) stops at its last page without an error.
const { execFile } = require("node:child_process");

const MAX_BUFFER = 64 << 20;

class ListReadError extends Error {
  constructor(message, { route, page, truncated = false } = {}) { super(message); this.name = "ListReadError"; this.route = route; this.page = page; this.truncated = truncated; }
}

// A gh api runner. token: run as Keir's own account. readOnly: refuse any write argument before gh runs.
const WRITE_ARGS = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]);
function ghApi({ token = "", timeoutMs = 60000, readOnly = false, maxBuffer = MAX_BUFFER, home = process.env.HOME || "/root", exec = execFile } = {}) {
  return (args) => {
    if (readOnly && args.some((a) => WRITE_ARGS.has(a))) return Promise.reject(new Error("read only: this caller never writes to GitHub"));
    return new Promise((resolve, reject) => exec("/usr/bin/gh", ["api", ...args], { timeout: timeoutMs, maxBuffer,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, ...(token ? { GH_TOKEN: token } : {}) } },
    (e, out) => { if (e) return reject(e); try { resolve(JSON.parse(out || "null")); } catch (err) { reject(new Error(`unreadable GitHub reply: ${err.message}`)); } }));
  };
}

// The fields the pull request passes read from a list (keirprs, ownerwait, devmerges, the preview). Bodies are capped.
const PR_FIELDS = '[.[] | {number, title, body: ((.body // "") | .[0:20000]), draft, state, created_at, updated_at, merged_at, closed_at, merge_commit_sha, user: {login: .user.login, type: .user.type}, head: {ref: .head.ref, sha: .head.sha, repo: {full_name: .head.repo.full_name}}, base: {ref: .base.ref}}]';
const REF_FIELDS = "[.[] | {ref, object: {sha: .object.sha}}]";

// Every item of a paged list. path: the route with its query, without per_page or page.
async function listAll(api, path, { perPage = 100, maxPages = 10, jq = null, window = false, key = (x) => x?.number ?? x?.ref ?? JSON.stringify(x) } = {}) {
  const out = [], seen = new Set();
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const route = `${path}${sep}per_page=${perPage}&page=${page}`;
    let rows;
    try { rows = await api(jq ? [route, "--jq", jq] : [route]); }
    catch (e) { throw new ListReadError(`could not read ${path.split("?")[0]} (page ${page}): ${String(e.message).split("\n")[0].slice(0, 160)}`, { route, page }); }
    if (!Array.isArray(rows)) throw new ListReadError(`could not read ${path.split("?")[0]} (page ${page}): not a list`, { route, page });
    let added = 0;
    for (const r of rows) { const k = key(r); if (seen.has(k)) continue; seen.add(k); out.push(r); added++; }
    // A short page is the last one. A page that adds nothing (an endpoint that ignores paging) ends it too.
    if (rows.length < perPage || !added) return out;
    if (page === maxPages) {
      if (window) return out;
      throw new ListReadError(`could not read ${path.split("?")[0]} in full: more than ${maxPages * perPage} items; did nothing`, { route, page, truncated: true });
    }
  }
  return out;
}

module.exports = { ghApi, listAll, ListReadError, PR_FIELDS, REF_FIELDS, MAX_BUFFER };
