// Client calls shared by the website and the apps. The request carries no
// client or page information.
export function requestLeaveParty(partyId: string) {
  return fetch(`/api/parties/${partyId}/leave`, { method: "POST" });
}

export function requestDonate(partyId: string, amount: number) {
  return fetch(`/api/parties/${partyId}/donate`, { method: "POST", body: JSON.stringify({ amount }) });
}
