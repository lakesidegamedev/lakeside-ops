// A new supply agreement signed during a turn starts delivering at the next
// turn's processing (firstDeliveryTurn = current turn + 1). Agreements end at
// their endTurn; nothing renews them automatically.
import type { Agreement } from "./types";

export function signAgreement(input: Omit<Agreement, "firstDeliveryTurn" | "status">, currentTurn: number): Agreement {
  return { ...input, firstDeliveryTurn: currentTurn + 1, status: "active" };
}
