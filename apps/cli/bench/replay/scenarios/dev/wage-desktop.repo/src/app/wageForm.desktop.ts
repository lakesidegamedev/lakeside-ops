// Desktop app wage form (AHDClient 2.4): sends the field's text.
export function wagePayload(sectorId: string, text: string) {
  return { sectorId, wage: text.trim() };
}
