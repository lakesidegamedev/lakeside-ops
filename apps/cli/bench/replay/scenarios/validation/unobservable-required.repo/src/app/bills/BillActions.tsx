// Actions on a bill page for a member of the chamber. "Support" records public
// backing (shown in the bill's supporters list and the member's activity); it
// is not a vote. "Vote" opens the division sheet, and the vote is only cast
// when the member presses "Cast vote" in that sheet.
import { useState } from "react";
import { endorseBill, castVote } from "@/lib/legislation/client";

export function BillActions({ bill, member }) {
  const [sheet, setSheet] = useState(false);
  const [choice, setChoice] = useState<"aye" | "no" | "abstain">("aye");
  return (
    <div className="bill-actions">
      <button className="btn btn-green" onClick={() => endorseBill(bill.id)} disabled={!bill.open}>Support</button>
      <button className="btn" onClick={() => setSheet(true)} disabled={!bill.divisionOpen}>Vote</button>
      {sheet && (
        <DivisionSheet choice={choice} onChoice={setChoice} onCancel={() => setSheet(false)}
          onCast={() => castVote(bill.id, choice).then(() => setSheet(false))} />
      )}
    </div>
  );
}
