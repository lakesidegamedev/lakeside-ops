// Website party page. Leaving asks for confirmation first.
import { requestLeaveParty } from "../lib/parties/api";

export async function onLeaveClicked(partyId: string, confirm: (text: string) => Promise<boolean>) {
  const ok = await confirm("Leave this party? Your seniority starts again at 0 if you rejoin.");
  if (!ok) return { ok: false };
  return requestLeaveParty(partyId);
}
