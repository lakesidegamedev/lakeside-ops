// Licence renewal. Auto-renew charges the fee and extends the licence by its
// term. Two paths can renew a licence in the same turn.
import { chargeCorporation } from "../finance/charge";
import type { Licence, Corporation } from "./types";

export const LICENCE_TERM_TURNS = 24;

// Path 1: licences whose expiry is this turn. Auto-renew ones are renewed.
export function processExpiringLicences(corp: Corporation, turn: number) {
  for (const licence of corp.licences) {
    if (licence.expiresTurn === turn && licence.autoRenew) renew(corp, licence, turn);
  }
}

// Path 2: the renewal queue, filled when a player ticks auto-renew. It does
// not check whether path 1 already renewed the licence this turn, so a
// licence that expires on the same turn it is queued is charged twice.
export function processRenewalQueue(corp: Corporation, turn: number) {
  for (const id of corp.renewalQueue) {
    const licence = corp.licences.find((l) => l.id === id);
    if (licence) renew(corp, licence, turn);
  }
  corp.renewalQueue = [];
}

function renew(corp: Corporation, licence: Licence, turn: number) {
  chargeCorporation(corp, licence.fee, { kind: "licence_fee", description: `${licence.type} licence renewal`, turn });
  licence.renewedTurn = turn;
  licence.expiresTurn = turn + LICENCE_TERM_TURNS;
}
