// Party membership on the server. A leave request ends membership at once and
// records the requesting account only; removals by the leadership are a
// separate action with their own record.
import type { Character, Party } from "./types";

export function leaveParty(character: Character, party: Party, turn: number) {
  const current = character.partyHistory.find((h) => h.party === party.name && h.leftTurn == null);
  if (!current) return { ok: false, error: "Not a member" };
  current.leftTurn = turn;
  current.seniorityTurns = turn - current.joinedTurn;
  current.ended = "left";
  character.party = null;
  logAction(character, { turn, action: "party.leave", party: party.name, requestedBy: "own account", result: "left" });
  return { ok: true };
}

export function removeMember(leader: Character, character: Character, party: Party, turn: number) {
  if (party.leader !== leader.name) return { ok: false, error: "Only the leader can remove members" };
  party.recentRemovals.push({ member: character.name, turn, by: leader.name });
  return leaveParty(character, party, turn);
}

// Rejoining starts seniority again at 0.
export function joinParty(character: Character, party: Party, turn: number) {
  character.party = party.name;
  character.partyHistory.push({ party: party.name, joinedTurn: turn, leftTurn: null, seniorityTurns: 0, ended: null });
  return { ok: true };
}

function logAction(character: Character, entry: Record<string, unknown>) {
  character.actions.push(entry);
}
