// Division votes. A vote is recorded only by castVote while the division is
// open; the division closes at the end of its turn and the tally is final.
import type { Bill, Member } from "./types";

export function castVote(bill: Bill, member: Member, choice: "aye" | "no" | "abstain", turn: number) {
  if (!bill.divisionOpen || turn !== bill.divisionTurn) return { ok: false, error: "The division is closed" };
  bill.votes[member.id] = { choice, turn };
  return { ok: true };
}

// Members with no recorded vote appear as "did not vote" on the division list.
export function divisionList(bill: Bill, members: Member[]) {
  return members.map((m) => ({ member: m.name, vote: bill.votes[m.id]?.choice ?? "did not vote" }));
}
