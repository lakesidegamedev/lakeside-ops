// Public support for a bill. Recorded in the member's activity as "Backed the
// bill"; it does not touch the division.
import type { Bill, Member } from "./types";

export function endorseBill(bill: Bill, member: Member, turn: number) {
  bill.supporters.add(member.id);
  member.activity.push({ turn, action: "Backed the bill (public support)", bill: bill.title });
  return { ok: true };
}
