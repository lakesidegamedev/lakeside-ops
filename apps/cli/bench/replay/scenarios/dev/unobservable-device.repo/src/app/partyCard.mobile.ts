// Mobile app party list card (AHDClient 2.5). Swipe actions were added in 2.5.
import { requestLeaveParty, requestDonate } from "../lib/parties/api";

export function onCardSwipe(partyId: string, direction: "left" | "right") {
  // Right swipe donates the default amount; left swipe leaves the party.
  // No confirmation step on either.
  if (direction === "left") return requestLeaveParty(partyId);
  return requestDonate(partyId, 5000);
}
