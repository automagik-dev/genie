// Runtime version (baked in at build time)
export const VERSION = '0.260206.1340';

// Generate version string from current datetime
// Format: 0.YYMMDD.HHMM (e.g., 0.260201.1430 = Feb 1, 2026 at 14:30)
export function generateVersion(): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  return `0.${yy}${mm}${dd}.${hh}${min}`;
}
