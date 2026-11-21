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
// background"), so only the established intake forms link from it: "Raised by
// Keir from ticket N", "from support ticket N", a "(ticket N)" aside, or a
// "Ticket: N" line.
const DETAIL_FORMS = [
  /\bfrom\s+(?:support\s+)?(?:ticket|incident)\s*#?(\d{1,6})(?![\d.]?\d)/gi,
  /\((?:support\s+)?(?:ticket|incident)\s*#?(\d{1,6})\)/gi,
  /^\s*(?:support\s+)?(?:ticket|incident)\s*(?::|#|no\.)\s*#?(\d{1,6})(?![\d.]?\d)/gim,
];
function ticketNumbersFromDetail(detail) {
  const text = String(detail || "");
  const out = [];
  for (const re of DETAIL_FORMS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
  }
  return out;
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

module.exports = { ticketRefsFromText, ticketNumbersFromText, ticketNumbersFromDetail, normalizeTicketInput };
