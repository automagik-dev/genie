/**
 * Service PID Registry — tracks child processes spawned by `genie serve`.
 *
 * In-memory registry of PIDs for pgserve, scheduler, and any other managed
 * services. Used during shutdown to ensure no orphan processes remain.
 */

interface ServiceEntry {
  pid: number;
  name: string;
  startedAt: Date;
}

/** In-memory registry of active service PIDs. */
const registry = new Map<string, ServiceEntry>();

/**
 * Register a service PID in the registry.
 * If a service with the same name already exists, it is replaced.
 */
export function registerService(name: string, pid: number): void {
  registry.set(name, { pid, name, startedAt: new Date() });
}

/** Unregister a service by name. */
export function unregisterService(name: string): void {
  registry.delete(name);
}

/** Get all registered services. */
export function getRegisteredServices(): ServiceEntry[] {
  return Array.from(registry.values());
}

/**
 * Reap dead services — check each PID with kill(pid, 0) and remove entries
 * whose processes are no longer alive.
 * Returns the names of reaped services.
 */
export function reapDeadServices(): string[] {
  const reaped: string[] = [];
  for (const [name, entry] of registry) {
    try {
      process.kill(entry.pid, 0);
    } catch {
      // Process is dead — remove from registry
      registry.delete(name);
      reaped.push(name);
    }
  }
  return reaped;
}

/**
 * Kill all registered services. Used during shutdown.
 * Sends SIGTERM first, waits briefly, then SIGKILL for any survivors.
 */
export function killAllServices(): void {
  for (const [_name, entry] of registry) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Already dead — clean up
      registry.delete(_name);
    }
  }

  // Brief grace period for SIGTERM to take effect
  const deadline = Date.now() + 3000;
  const checkInterval = 200;

  const stillAlive = () => {
    for (const [, entry] of registry) {
      try {
        process.kill(entry.pid, 0);
        return true;
      } catch {
        // dead
      }
    }
    return false;
  };

  // Synchronous busy-wait for up to 3s (shutdown context, blocking is acceptable)
  while (Date.now() < deadline && stillAlive()) {
    const waitUntil = Date.now() + checkInterval;
    while (Date.now() < waitUntil) {
      // busy wait
    }
  }

  // SIGKILL any survivors
  for (const [name, entry] of registry) {
    try {
      process.kill(entry.pid, 0); // check alive
      process.kill(entry.pid, 'SIGKILL');
    } catch {
      // Already dead
    }
    registry.delete(name);
  }
}

/** Clear the registry without killing anything (for testing). */
export function clearRegistry(): void {
  registry.clear();
}
