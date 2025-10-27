export const FORGE_RECOVERY_HINT =
  "Forge backend connection failed. Try running 'genie' again to restart Forge, or check if another Genie instance is running.";

export function describeForgeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
