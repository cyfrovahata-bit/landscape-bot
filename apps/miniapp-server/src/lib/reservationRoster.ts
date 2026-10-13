/** Release only reservations still held by this foreman, absent from the new roster. */
export function removedHeldEmployees(held: string[], roster: string[]): string[] {
  const keep = new Set(roster);
  return [...new Set(held)].filter(id => !keep.has(id));
}
