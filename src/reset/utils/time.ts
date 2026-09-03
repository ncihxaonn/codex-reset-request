export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function isWithinPreviousHours(timestamp: string, hours: number, now: Date = new Date()): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value <= now.getTime() && value >= now.getTime() - hours * 60 * 60 * 1000;
}
