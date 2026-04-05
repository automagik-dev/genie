/**
 * Ambient type declarations for @khal-os packages.
 *
 * These packages will be resolved from the khal-os app-kit once published.
 * Until then, these declarations provide compile-time types for the manifest
 * and UI SDK imports used by genie-app.
 */

declare module '@khal-os/sdk/app' {
  /** Identity wrapper that provides compile-time validation for app manifests. */
  export function defineManifest<T>(manifest: T): T;
}

declare module '@khal-os/sdk' {
  export function defineManifest<T>(manifest: T): T;
}

declare module '@khal-os/ui' {
  // UI primitives — stubs until the real package is available
  export const Toolbar: React.FC<Record<string, unknown>>;
  export const SplitPane: React.FC<Record<string, unknown>>;
  export const StatusBar: React.FC<Record<string, unknown>>;
  export const EmptyState: React.FC<Record<string, unknown>>;
}

declare module '@khal-os/types' {
  export interface AppManifest {
    id: string;
    views: unknown[];
    desktop?: unknown;
    services?: unknown[];
    tauri?: unknown;
    store?: unknown;
    [key: string]: unknown;
  }
}
