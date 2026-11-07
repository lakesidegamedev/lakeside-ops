// Unit tests for the program tracker: checkbox and reference parsing, state
// derivation, the loader against fake GitHub and kanban, and rendering.
// Run: node --test program-tracker.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const t = require("./program-tracker");

const PROGRAM = t.PROGRAMS["reset-2027"];
const NOW = Date.parse("2026-11-07T18:00:00Z");

function issue(number, over = {}) {
  return { number, title: `Workstream ${number}`, state: "open", url: `https://github.com/o/r/issues/${number}`, labels: [], checkboxes: { done: 0, total: 0 }, closed_at: null, children: [], ...over };
}
function pr(number, over = {}) {
  return { number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: "closed", draft: false, merged_at: "2026-11-07T16:00:00Z", refs: [], onDev: false, live: false, checks: null, ...over };
}
function snapshot(over = {}) {
  const cards = [
    { id: 7, title: "card 1", lane: "now", assigned_to: "claude:w5", progress_summary: "Parsed the tracker issue. Next is the view.", last_progress_at: "2026-11-07T17:00:00Z", evidence_url: null, github: { number: 1 } },
    { id: 8, title: "Local only", lane: "next", progress_summary: "", github: null },
  ];
  return {
    slug: "reset-2027",
    refreshedAt: "2026-11-07T17:58:00Z",
    github: {
      tracker: { number: 5687, title: "tracker", state: "open", url: "u" },
      tree: [
        issue(1, { checkboxes: { done: 2, total: 4 }, children: [issue(11, { state: "closed" })] }),
        issue(2, { labels: ["blocked"] }),
        issue(3, { state: "closed" }),
      ],
      milestone: { number: 3, title: "1.20 / 2027 world", open: 15, closed: 1, url: "https://github.com/o/r/milestone/3" },
      prs: [
        pr(10, { refs: [11], onDev: true, live: true, merged_at: "2026-11-06T10:00:00Z" }),
        pr(12, { refs: [3], onDev: true }),
        pr(13, { refs: [1], state: "open", merged_at: null, checks: { pass: 3, fail: 1, pending: 0 } }),
      ],
      compare: { ahead_by: 2, behind_by: 1, status: "diverged", branchInDev: false },
    },
    kanban: {
      card: { id: 255145, title: "program" },
      children: cards,
      cards,
      events: [{ item_id: 7, title: "card 1", event_type: "progress", actor: "claude", summary: "Started", created_at: "2026-11-07T17:30:00Z" }],
    },
    ...over,
  };
}

describe("parseCheckboxes", () => {
  it("counts done and open task boxes", () => {
    assert.deepEqual(t.parseCheckboxes("- [x] a\n- [ ] b\n* [X] c\n1. [ ] d\nnot - [x] inline"), { done: 2, total: 4 });
  });
  it("ignores boxes inside fenced code", () => {
    assert.deepEqual(t.parseCheckboxes("- [x] real\n```\n- [ ] example\n```\n- [ ] open"), { done: 1, total: 2 });
  });
  it("handles empty and null bodies", () => {
    assert.deepEqual(t.parseCheckboxes(null), { done: 0, total: 0 });
  });
});

describe("parseRefs", () => {
  it("collects same-repo references after keywords", () => {
    assert.deepEqual(t.parseRefs("Refs #12\nFixes #3, #4 and #5\npart of lakesidegamedev/AHDGame#9", "lakesidegamedev/AHDGame"), [3, 4, 5, 9, 12]);
  });
  it("skips other repos and bare numbers", () => {
    assert.deepEqual(t.parseRefs("Refs other/repo#7. See #8.", "lakesidegamedev/AHDGame"), []);
  });
});

describe("deriveState", () => {
  it("places closed work by its least delivered merged PR", () => {
    const closed = issue(1, { state: "closed" });
    assert.equal(t.deriveState({ issue: closed, prs: [] }), "done");
    assert.equal(t.deriveState({ issue: closed, prs: [pr(1, { live: true, onDev: true })] }), "live");
    assert.equal(t.deriveState({ issue: closed, prs: [pr(1, { live: true, onDev: true }), pr(2, { onDev: true })] }), "on_dev");
    assert.equal(t.deriveState({ issue: closed, prs: [pr(1)] }), "on_branch");
  });
  it("marks open work blocked by label or lane, else in progress or open", () => {
    assert.equal(t.deriveState({ issue: issue(1, { labels: ["status: blocked"] }), prs: [] }), "blocked");
    assert.equal(t.deriveState({ issue: issue(1), card: { lane: "blocked" }, prs: [] }), "blocked");
    assert.equal(t.deriveState({ issue: issue(1), card: { lane: "now" }, prs: [] }), "in_progress");
    assert.equal(t.deriveState({ issue: issue(1, { checkboxes: { done: 1, total: 3 } }), prs: [] }), "in_progress");
    assert.equal(t.deriveState({ issue: issue(1), prs: [] }), "open");
  });
});

describe("summarize", () => {
  it("counts states across nested sub-issues and kanban-only cards", () => {
    const sum = t.summarize(snapshot());
    assert.equal(sum.total, 4);
    assert.equal(sum.closed, 2);
    assert.equal(sum.merged, 2);
    assert.deepEqual(sum.rows.map((r) => [r.issue && r.issue.number, r.depth, r.state]), [
      [1, 0, "in_progress"], [11, 1, "live"], [2, 0, "blocked"], [3, 0, "on_dev"], [null, 0, "open"],
    ]);
    assert.equal(sum.openPrs.length, 1);
    assert.equal(sum.mergedPrs[0].number, 12, "newest merge first");
  });
});

describe("activity", () => {
  it("merges kanban events and merged PRs newest first", () => {
    const acts = t.activity(snapshot());
    assert.deepEqual(acts.map((a) => a.kind), ["kanban", "pr", "pr"]);
  });
});

describe("loadProgramSnapshot", () => {
  function fakeFetch(routes) {
    const seen = [];
    const impl = async (url) => {
      const path = url.replace("https://api.github.com/", "");
      seen.push(path);
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => routes[key] };
    };
    impl.seen = seen;
    return impl;
  }
  const kanbanStore = () => ({
    get: (id) => ({ id, title: "program", github: null }),
    list: () => ({ items: [] }),
    db: { prepare: () => ({ all: () => [] }) },
  });
  const repo = PROGRAM.repo;
  const routes = {
    [`repos/${repo}/issues/5687/sub_issues`]: [{ number: 1, title: "A", state: "open", html_url: "x", labels: [{ name: "enhancement" }], body: "- [x] a\n- [ ] b", sub_issues_summary: { total: 0 } }],
    [`repos/${repo}/issues/5687`]: { number: 5687, title: "T", state: "open", html_url: "x", milestone: { number: 3, title: PROGRAM.milestone, open_issues: 4, closed_issues: 1, html_url: "m" } },
    [`repos/${repo}/pulls`]: [{ number: 9, title: "fix", body: "Refs #1", state: "closed", merged_at: "2026-11-07T10:00:00Z", merge_commit_sha: "abc", html_url: "p", head: { sha: "h" } }],
    [`repos/${repo}/compare/development...release`]: { ahead_by: 0, behind_by: 3, status: "behind" },
    [`repos/${repo}/compare/main...abc`]: { status: "diverged" },
  };

  it("builds the tree, PR stages and milestone from GitHub", async () => {
    const fetchImpl = fakeFetch(routes);
    const s = await t.loadProgramSnapshot(PROGRAM, { token: "x", kanban: kanbanStore, fetchImpl });
    assert.equal(s.github.error, undefined);
    assert.deepEqual(s.github.tree[0].checkboxes, { done: 1, total: 2 });
    assert.deepEqual(s.github.tree[0].labels, ["enhancement"]);
    assert.deepEqual(s.github.prs[0].refs, [1]);
    assert.equal(s.github.prs[0].onDev, true, "branch fully in development puts every merged PR on dev");
    assert.equal(s.github.prs[0].live, false);
    assert.equal(s.github.milestone.open, 4);
    assert.ok(!fetchImpl.seen.some((p) => p.startsWith(`repos/${repo}/compare/development...abc`)), "no per-PR dev compare when the branch is merged");
    assert.equal(s.kanban.card.id, 255145);
  });

  it("reports a missing token and a kanban failure without throwing", async () => {
    const s = await t.loadProgramSnapshot(PROGRAM, { token: "", kanban: () => { throw new Error("db locked"); } });
    assert.match(s.github.error, /token/);
    assert.equal(s.kanban.error, "db locked");
  });

  it("keeps the previous GitHub data when a refresh fails", async () => {
    const previous = snapshot();
    const s = await t.loadProgramSnapshot(PROGRAM, { token: "x", kanban: kanbanStore, fetchImpl: fakeFetch({}), previous });
    assert.equal(s.github.tree.length, 3);
    assert.match(s.github.staleError, /GitHub 404/);
    assert.equal(s.github.staleSince, previous.refreshedAt);
  });
});

describe("makeProgramBody", () => {
  it("renders the loading state while the snapshot warms", () => {
    const { body } = t.makeProgramBody(PROGRAM, null);
    assert.match(body, /\/api\/programs\/reset-2027\/cache-status/);
  });

  it("renders every section from a fixture snapshot", () => {
    const { body } = t.makeProgramBody(PROGRAM, snapshot(), { now: NOW });
    assert.match(body, /2027 world/);
    assert.match(body, /issues\/5687/);
    assert.match(body, /milestone\/3/);
    assert.match(body, /compare\/development\.\.\.release\/1\.20-2027/);
    assert.match(body, /\/kanban#item-255145/);
    assert.match(body, /2\/4<\/span><span class="l">workstreams closed \(50%\) · 2 PRs merged/);
    assert.match(body, /Parsed the tracker issue\./);
    assert.match(body, /Kanban only/);
    assert.match(body, /1 failing<\/span> · <span class="ok">3 passed/);
    assert.match(body, /<i class="on"[^>]*><\/i><i class="on"[^>]*><\/i><i class=""/, "PR on dev lights two rail segments");
    assert.match(body, /Refreshed 2m ago/);
    assert.ok(!/[–—]/.test(body), "no em or en dashes in copy");
  });

  it("renders empty and error states", () => {
    const { body } = t.makeProgramBody(PROGRAM, { slug: "reset-2027", refreshedAt: "2026-11-07T17:58:00Z", github: { error: "GitHub 502" }, kanban: { error: "db locked" } }, { now: NOW });
    assert.match(body, /GitHub data is unavailable/);
    assert.match(body, /Kanban data is unavailable/);
    assert.match(body, /No workstreams while GitHub is unavailable/);
    assert.match(body, /Nothing merged into release\/1\.20-2027 yet/);
    assert.match(body, /No recent activity/);
  });

  it("escapes GitHub and kanban text", () => {
    const s = snapshot();
    s.github.tree[0].title = '<img src=x onerror="alert(1)">';
    s.kanban.cards[0].progress_summary = "<script>bad()</script> is the plan.";
    const { body } = t.makeProgramBody(PROGRAM, s, { now: NOW });
    assert.ok(!body.includes("<img src=x"));
    assert.ok(!body.includes("<script>bad"));
  });
});
