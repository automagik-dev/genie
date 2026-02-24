// Runtime version (baked in at build time)
export const VERSION = '3.260224.1';

// Generate version string from current date
// Format: 3.YYMMDD.N (e.g., 3.260201.1 = Feb 1, 2026, first publish of the day)
export function generateVersion(): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  return `3.${yy}${mm}${dd}.0`;
}
