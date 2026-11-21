"use strict";

// Which support tickets a kanban card names. Pure and conservative: a number
// is a ticket only when the word "ticket" or "incident" sits right next to it
// ("ticket 1852", "Ticket #1852", "tickets 1852 and 1853", "(ticket 1852)",
// "incident 41"). A bare "#7025" (usually a pull request or issue), a turn
// number, a year or a version is never a ticket.

// "ticket"/"tickets"/"incident"/"incidents", optional "#" or "no.", then one
// number, optionally followed by more numbers joined with commas, "and", "&"
// or "/". "ticket-1852" and "support-ticket-1852" (branch and tracker ids)
// count. The lookbehind stops "subticket 4"; the lookaheads stop "1852.3"
// (versions) and "1852px" without backtracking to a shorter number.
const REF_RE = /(?<!\w)(ticket|incident)(s?)[\s-]*(?:#|no\.?\s*|number\s+)?(\d{1,6})(?![\d.]?\d)((?:\s*(?:,|&|\/|and)\s*#?\d{1,6}(?![\d.]?\d))*)(?![a-z%])/gi;
const MORE_RE = /#?(\d{1,6})/g;

// Returns [{ number, kind: "ticket" | "incident" }], deduplicated, in the
// order they first appear.
function ticketRefsFromText(...texts) {
  const out = [];
  const seen = new Set();
  for (const raw of texts) {
    const text = String(raw || "");
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(text))) {
      const kind = m[1].toLowerCase();
      // "tickets 5 bugs" is a count, not a reference: the plural only names
      // tickets when it introduces a list ("tickets 1852 and 1853").
      if (m[2] && !m[4]) continue;
      const numbers = [m[3]];
      // A list continues only with numbers of the same length, so "ticket
      // 1852 and 3 others" does not link ticket 3.
      if (m[4]) for (const more of m[4].matchAll(MORE_RE)) { if (more[1].length !== m[3].length) break; numbers.push(more[1]); }
      for (const n of numbers) {
        const number = Number(n);
        if (!Number.isSafeInteger(number) || number <= 0) continue;
        if (seen.has(number)) continue;
        seen.add(number);
        out.push({ number, kind });
      }
    }
  }
  return out;
}

// Just the numbers.
function ticketNumbersFromText(...texts) {
  return ticketRefsFromText(...texts).map((r) => r.number);
}

// A card's longer detail mentions tickets for context ("see ticket 1700 for
// background", "the re-entry bar (ticket 1391) is working as designed"), so
// only the established intake forms link from it: "Raised by Keir from ticket
// N", "from support ticket N", a "Ticket: N" line, or a "(ticket N)" aside
// that ends the card's last line. An aside in the middle of the text is
// background, not the card's source.
const DETAIL_FORMS = [
  /\bfrom\s+(?:support\s+)?(?:ticket|incident)\s*#?(\d{1,6})(?![\d.]?\d)/gi,
  /^\s*(?:support\s+)?(?:ticket|incident)\s*(?::|#|no\.)\s*#?(\d{1,6})(?![\d.]?\d)/gim,
];
const LAST_LINE_ASIDE = /\((?:support\s+)?(?:ticket|incident)\s*#?(\d{1,6})\)[.\s]*$/i;
function ticketNumbersFromDetail(detail) {
  const text = String(detail || "");
  const out = [];
  const add = (value) => {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  };
  for (const re of DETAIL_FORMS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) add(m[1]);
  }
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  const aside = last.match(LAST_LINE_ASIDE);
  if (aside) add(aside[1]);
  return out;
}

// Card forms that are purely a ticket's own status or question, and nothing
// else, so the card ends when the ticket closes. Derived from the 2026-11-21
// hand sweep of 612 cards: of the ticket cards it closed as finished, only
// Keir's "Ticket N: no confirmed answer for the player" closed because the
// ticket closed (2 of 2; the card "only tracked that the player had no answer
// yet"). Every other closed ticket card closed because a fix shipped, and the
// same title shapes ("(ticket N)", "Raised by Keir from ticket N") also held
// the six cards the sweep kept as real follow-up work. So nothing else is
// listed: anything not here, and not explicitly filed as the ticket's own
// work by its caller, is a follow-up that outlives the ticket.
const OWN_FORMS = [
  /^ticket\s+#?(\d{1,6}):\s+no confirmed answer for the player\.?$/i,
];
// The ticket number when the title is one of those forms, else null.
function ticketOwnForm(title) {
  const t = String(title || "").trim();
  for (const re of OWN_FORMS) {
    const m = t.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// Accepts 1852, "1852", "#1852", [1852, 1853], or [{ number: 1852 }].
// Throws on anything that is not a positive whole number.
function normalizeTicketInput(input) {
  if (input === undefined || input === null || input === "") return [];
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const value of list) {
    const raw = value && typeof value === "object" ? value.number : value;
    const n = Number(String(raw).replace(/^#/, "").trim());
    if (!Number.isSafeInteger(n) || n <= 0) {
      const error = new Error(`ticket must be a ticket number, got "${raw}"`);
      error.code = "BAD_INPUT";
      throw error;
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

module.exports = { ticketRefsFromText, ticketNumbersFromText, ticketNumbersFromDetail, ticketOwnForm, normalizeTicketInput };
