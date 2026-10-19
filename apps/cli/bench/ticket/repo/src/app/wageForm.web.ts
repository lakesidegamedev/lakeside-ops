// Website wage form: sends the wage as a number.
export function wagePayload(sectorId: string, field: HTMLInputElement) {
  return { sectorId, wage: field.valueAsNumber };
}
