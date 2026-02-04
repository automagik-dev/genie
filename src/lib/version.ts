// Runtime version (baked in at build time)
export const VERSION = '0.260204.1513';

// Generate version string from current datetime
// Format: 0.YYMMDD.HHMM (e.g., 0.260201.1430 = Feb 1, 2026 at 14:30)
export function generateVersion(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  return `0.${yy}${mm}${dd}.${hh}${min}`;
}
