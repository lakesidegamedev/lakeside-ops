// Unit tests for the tickets pages: one status vocabulary for both viewers,
// one URL per ticket, and no staff internals on the public view.
// Run: node --test tickets-page.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeTicketsListBody,
  makeTicketDetailBody,
  renderTrackedWork,
  stageBar,
  stageFor,
  TRIAGE_LABEL,
  OUTCOME_STATUS_TEXT,
} = require("./tickets-page");

// Every outcome the box filer can record must have player words. A missing
// entry renders as a raw outcome key on a reporter's page.
describe("OUTCOME_STATUS_TEXT", () => {
  it("covers every filer outcome", () => {
    for (const outcome of ["filed", "linked", "duplicate", "already-fixed", "needs-human", "would-file"]) {
      assert.ok(OUTCOME_STATUS_TEXT[outcome], "missing player text for: " + outcome);
    }
  });

  it("stays in step with the staff labels", () => {
    for (const outcome of Object.keys(TRIAGE_LABEL)) {
      assert.ok(OUTCOME_STATUS_TEXT[outcome], "staff label without player text: " + outcome);
    }
  });
});

function ticketDoc(over = {}) {
  return {
    _id: "68c000000000000000000000",
    ticketNumber: 99,
    title: "Character title missing",
    description: "My title does not show.",
    messages: [{ authorName: "reporter", content: "My title does not show.", createdAt: "2026-09-01T00:00:00Z", imageUrls: [] }],
    imageUrls: [],
    status: "open",
    category: "bug",
    tags: [],
    statusHistory: [],
    createdAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

function githubRecord(over = {}) {
  return {
    publicRepo: false,
    artifacts: {},
    latest: { outcome: "needs-human", why: "not actionable", issuesFiled: [], relatedIssues: [], relatedPrs: [] },
    history: [],
    ...over,
  };
}

describe("makeTicketDetailBody", () => {
  it("shows the same status and stage to both viewers", () => {
    const ticket = ticketDoc();
    const github = githubRecord();
    const staff = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "staff" }).body;
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "public" }).body;
    // Same Mongo status badge on both.
    assert.ok(staff.includes("open") && pub.includes("Report received"));
    // Same pipeline step on both (needs-human -> triaged -> step 2 of 5).
    assert.ok(staff.includes("step 2 of 5"), "staff view must show the stage");
    assert.ok(pub.includes("step 2 of 5"), "public view must show the same stage");
    // Staff vocabulary stays internal; the public page uses the receipt
    // vocabulary and does not expose classifier wording.
    assert.ok(staff.includes(TRIAGE_LABEL["needs-human"]));
    assert.ok(pub.includes("Report received"));
    assert.ok(!pub.includes("not actionable"));
  });

  it("keeps staff internals off the public view", () => {
    const ticket = ticketDoc();
    const github = githubRecord();
    const assessment = { status: "ok", model: "jev-latest", summary: "SECRET-INTERNAL-SUMMARY", complexity: "low", risk: "low", confidence: 0.9 };
    const staff = makeTicketDetailBody({ ticket, assessment, fixSession: null, github, viewer: "staff" }).body;
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "public" }).body;
    assert.ok(staff.includes("SECRET-INTERNAL-SUMMARY"), "staff view must show the assessment");
    assert.ok(!staff.includes('id="cm-launch-btn"'), "retired Code sessions cannot be launched");
    assert.ok(!pub.includes("SECRET-INTERNAL-SUMMARY"), "public view must not leak the assessment");
    for (const marker of ["Launch fix", "Close ticket", "Re-run triage", "Conversation", "not actionable"]) {
      assert.ok(!pub.includes(marker), "public view must not contain: " + marker);
    }
    // No ticket number on the public page: the token URL carries no number.
    assert.ok(!pub.includes("#99"), "public view must not show the ticket number");
  });

  it("shows recent game pages only in the staff ticket view", () => {
    const ticket = ticketDoc({ supportRecentVisits: [{
      path: "/market",
      recordedAt: "2026-10-09T10:00:00.000Z",
      platform: "Android",
      device: "mobile",
      gameVersion: "1.2.3",
      clientVersion: "2.4.0",
    }] });
    const staff = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github: githubRecord(), viewer: "staff" }).body;
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github: githubRecord(), viewer: "public" }).body;
    assert.match(staff, /Recent game context \(staff only\)/);
    assert.match(staff, /\/market/);
    assert.match(staff, /Android, mobile/);
    assert.match(staff, /game 1\.2\.3 · client 2\.4\.0/);
    assert.doesNotMatch(pub, /Recent game context|\/market|1\.2\.3|2\.4\.0/);
  });

  it("gives a resolved report one canonical public status and a durable receipt", () => {
    const ticket = ticketDoc({
      status: "resolved",
      updatedAt: "2026-09-03T00:00:00Z",
      closedAt: "2026-09-03T00:00:00Z",
      statusHistory: [
        { status: "open", at: "2026-09-01T00:00:00Z", source: "bot" },
        { status: "in_progress", at: "2026-09-02T00:00:00Z", source: "mcp" },
        { status: "resolved", at: "2026-09-03T00:00:00Z", source: "mcp" },
      ],
      publicUpdates: [
        { key: "development:12", kind: "development", message: "A fix is ready for testing.", at: "2026-09-02T12:00:00Z" },
        { key: "heal:run-1", kind: "heal", message: "Game data corrected.", at: "2026-09-02T13:00:00Z" },
      ],
      resolution: {
        message: "We restored the missing title.",
        actions: [{ label: "Restored the affected game record" }],
        followUp: "Refresh once, then reply if it is still missing.",
        source: "agent",
        resolvedAt: "2026-09-03T00:00:00Z",
        createdAt: "2026-09-03T00:00:00Z",
      },
    });
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github: githubRecord(), viewer: "public" }).body;
    assert.match(pub, /Support receipt/);
    assert.match(pub, /Resolved/);
    assert.match(pub, /What we did/);
    assert.match(pub, /restored the missing title/i);
    assert.match(pub, /Restored the affected game record/);
    assert.match(pub, /Game data corrected/);
    assert.doesNotMatch(pub, /Tracked work/);
    assert.doesNotMatch(pub, /private diagnosis/);
  });

  it("keeps the receipt timeline readable on a narrow screen", () => {
    const view = makeTicketDetailBody({
      ticket: ticketDoc({
        status: "closed",
        closedAt: "2026-09-03T00:00:00Z",
        statusHistory: [
          { status: "open", at: "2026-09-01T00:00:00Z" },
          { status: "in_progress", at: "2026-09-02T00:00:00Z" },
        ],
        resolution: { message: "The issue is resolved.", source: "agent", createdAt: "2026-09-03T00:00:00Z" },
      }),
      assessment: null,
      fixSession: null,
      github: githubRecord(),
      viewer: "public",
    });
    assert.match(view.body, /cm-receipt-event-head/);
    assert.match(view.body, /cm-receipt-event-main/);
    assert.match(view.extraCss, /cm-receipt-event-head\{display:block\}/);
    // The marker is generated by ::before. A second empty grid child would
    // move the event body into the 1rem marker column and stack every date
    // component vertically on a phone.
    assert.doesNotMatch(view.body, /<span aria-hidden="true"><\/span>/);
  });

  it("shows public issue and fix PR links when the repository is public", () => {
    const github = githubRecord({
      publicRepo: true,
      latest: {
        outcome: "filed",
        repo: "Egg3901/AHDGame",
        issuesFiled: [{ repo: "Egg3901/AHDGame", number: 2115, title: "Title not displayed" }],
        relatedIssues: [],
        relatedPrs: [{ repo: "Egg3901/AHDGame", number: 2120, title: "Fix title rendering", state: "OPEN" }],
      },
      artifacts: { issues: [{ number: 2115, state: "OPEN" }], prs: [{ number: 2120, state: "OPEN" }] },
    });
    const pub = makeTicketDetailBody({ ticket: ticketDoc(), assessment: null, fixSession: null, github, viewer: "public" }).body;
    assert.match(pub, /Related public work/);
    assert.match(pub, /https:\/\/github\.com\/Egg3901\/AHDGame\/issues\/2115/);
    assert.match(pub, /https:\/\/github\.com\/Egg3901\/AHDGame\/pull\/2120/);
    assert.match(pub, /Fix PR #2120/);
  });

  it("asks for missing report context without exposing internal fields", () => {
    const pub = makeTicketDetailBody({
      ticket: ticketDoc({
        title: "The market page is broken",
        description: "The market page does not match consumption on mobile.",
        reporter: {},
      }),
      assessment: null,
      fixSession: null,
      github: githubRecord(),
      viewer: "public",
    }).body;
    assert.match(pub, /Help us identify this report/);
    assert.match(pub, /Link your Discord account to the game/);
    assert.match(pub, /affected page.*link.*exact menu path/i);
    assert.doesNotMatch(pub, /gameUserId|contextRequest|jev-latest/);
  });

  it("does not ask for context that is already linked", () => {
    const pub = makeTicketDetailBody({
      ticket: ticketDoc({
        title: "The market page is broken",
        description: "The market page does not match consumption.",
        userId: "game-user-1",
        pageUrl: "https://www.ahousedividedgame.com/market",
        reporter: {
          characterName: "Reporter",
          profileUrl: "https://www.ahousedividedgame.com/character/1",
          corporationUrl: "https://www.ahousedividedgame.com/corporation/2",
        },
      }),
      assessment: null,
      fixSession: null,
      github: githubRecord(),
      viewer: "public",
    }).body;
    assert.doesNotMatch(pub, /Help us identify this report/);
  });

  it("does not claim a complete receipt when a terminal record lacks details", () => {
    const ticket = ticketDoc({ status: "closed", closedAt: "2026-09-03T00:00:00Z" });
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github: githubRecord(), viewer: "public" }).body;
    assert.match(pub, /The outcome is recorded/);
    assert.match(pub, /preparing the player-facing receipt details/);
    assert.doesNotMatch(pub, /This report is complete/);
    assert.doesNotMatch(pub, /What we did/);
  });

  it("uses the terminal ticket status when GitHub triage is stale", () => {
    const ticket = ticketDoc({
      status: "closed",
      closedAt: "2026-09-03T00:00:00Z",
      resolution: {
        message: "Verified the requested account state in production.",
        actions: [{ label: "Verified the production record" }],
        source: "agent",
        resolvedAt: "2026-09-03T00:00:00Z",
      },
    });
    const body = makeTicketDetailBody({
      ticket,
      assessment: null,
      fixSession: null,
      github: githubRecord({ latest: { outcome: "needs-human", why: "not actionable", issuesFiled: [], relatedIssues: [], relatedPrs: [] } }),
      viewer: "staff",
      tracked: { status: "tracked", project: "a-house-divided" },
    }).body;

    assert.match(body, /aria-label="Closed, terminal status"/);
    assert.match(body, /GitHub triage <span class="cm-muted">\(historical\)<\/span>/);
    assert.doesNotMatch(body, /Referred to a human: not actionable/);
    assert.doesNotMatch(body, /Tracked work/);
  });
});

describe("stageFor/stageBar", () => {
  it("derives triaged from a needs-human verdict with no artefacts", () => {
    assert.equal(stageFor({}, { outcome: "needs-human" }), "triaged");
    assert.ok(stageBar("triaged").includes("step 2 of 5"));
  });

  it("a merged confident PR means fixed", () => {
    const latest = { outcome: "filed", relatedPrs: [{ number: 12, confidence: 0.9 }] };
    const artifacts = { prs: [{ number: 12, state: "MERGED", mergedAt: "2026-09-02T00:00:00Z" }] };
    assert.equal(stageFor(artifacts, latest), "fixed");
  });
});

describe("renderTrackedWork", () => {
  const linked = {
    id: "support-ticket-99",
    status: "blocked",
    blocked_by: "waiting on deploy",
    project: "a-house-divided",
    updated_by: "fable",
    updated_at: 1757280000000,
  };

  it("renders nothing with no linked item", () => {
    assert.equal(renderTrackedWork(null, "public"), "");
    assert.equal(renderTrackedWork(null, "staff"), "");
  });

  it("shows reporters the stage and the stuck reason, never internals", () => {
    const pub = renderTrackedWork(linked, "public");
    assert.ok(pub.includes("Tracked work"));
    assert.ok(pub.includes("blocked"));
    assert.ok(pub.includes("waiting on deploy"));
    assert.ok(!pub.includes("support-ticket-99"), "public card must not carry the tracker id");
    assert.ok(!pub.includes("#99"), "public card must not carry the ticket number");
    assert.ok(!pub.includes("fable"), "public card must not name who touched it");
    assert.ok(!pub.includes("/tracker"), "public card links nowhere internal");
  });

  it("shows staff the linked item and the way into the board", () => {
    const staff = renderTrackedWork(linked, "staff");
    assert.ok(staff.includes("support-ticket-99"));
    assert.ok(staff.includes("/tracker"));
    assert.ok(staff.includes("a-house-divided"));
  });

  it("keeps tracker details staff-only on the receipt page", () => {
    const ticket = ticketDoc();
    const github = githubRecord();
    const staff = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "staff", tracked: linked }).body;
    const pub = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "public", tracked: linked }).body;
    assert.ok(staff.includes("support-ticket-99"));
    assert.ok(pub.includes("Support receipt"));
    assert.ok(!pub.includes("Tracked work"));
    assert.ok(!pub.includes("support-ticket-99"));
    const unlinked = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "public" }).body;
    assert.ok(!unlinked.includes("Tracked work"), "unlinked reports render exactly as before");
  });
});

describe("makeTicketsListBody", () => {
  const rows = [
    { ticketNumber: 42, title: "Token ticket", status: "open", category: "bug", createdAt: "2026-09-01T00:00:00Z" },
    { ticketNumber: 43, title: "Unswept ticket", status: "open", category: "bug", createdAt: "2026-09-01T00:00:00Z" },
  ];
  const base = { tickets: rows, page: 1, totalPages: 1, status: "all", total: 2 };

  it("links the scrambled URL when a token is known", () => {
    const { body } = makeTicketsListBody({ ...base, tokens: { 42: "tok-42" } });
    assert.ok(body.includes('href="/t/tok-42"'), "token row must link /t/<token>");
    assert.ok(body.includes('href="/tickets/43"'), "row without a token keeps the numeric staff link");
  });

  it("falls back to numeric links with no token map", () => {
    const { body } = makeTicketsListBody(base);
    assert.ok(body.includes('href="/tickets/42"'));
  });
});

describe("investigation privacy",()=>{
 it("never renders investigation metadata through a public receipt",()=>{
  const rendered=makeTicketDetailBody({ticket:{ticketNumber:999,category:"investigation",title:"Confidential subject",description:"Private detector evidence",messages:[{content:"Secret transcript"}],status:"open"},viewer:"public"});
  assert.match(rendered.body,/Ticket not found/);assert.doesNotMatch(rendered.body,/Confidential|Private detector|Secret transcript|999/);
 });
});
