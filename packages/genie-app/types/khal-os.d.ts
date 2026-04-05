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

  /** Hook: returns a NATS client with request/reply and publish. */
  export function useNats(): {
    request: <T = unknown>(subject: string, data?: unknown) => Promise<T>;
    publish: (subject: string, data?: unknown) => void;
    connected: boolean;
  };

  /** Hook: subscribes to a NATS subject and calls handler on each message. */
  export function useNatsSubscription<T = unknown>(subject: string, handler: (data: T) => void, deps?: unknown[]): void;
}

declare module '@khal-os/sdk' {
  export function defineManifest<T>(manifest: T): T;
}

declare module '@khal-os/ui' {
  import type { CSSProperties, ReactNode } from 'react';

  // UI primitives — stubs until the real package is available
  export const Toolbar: React.FC<Record<string, unknown>>;

  export const SplitPane: React.FC<{
    left: ReactNode;
    right: ReactNode;
    defaultSplit?: number;
    minLeft?: number;
    minRight?: number;
    style?: CSSProperties;
  }>;

  export const ListView: React.FC<{
    children: ReactNode;
    style?: CSSProperties;
  }>;

  export const CollapsibleSidebar: React.FC<{
    items: Array<{
      id: string;
      label: string;
      icon: ReactNode;
      section?: 'top' | 'bottom';
    }>;
    activeId: string;
    onSelect: (id: string) => void;
    collapsed?: boolean;
    onCollapseChange?: (collapsed: boolean) => void;
    style?: CSSProperties;
  }>;

  export const StatusBar: React.FC<{
    items?: Array<{ key: string; label: ReactNode }>;
    style?: CSSProperties;
  }>;

  export const Badge: React.FC<{
    children: ReactNode;
    variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
    style?: CSSProperties;
  }>;

  export const Button: React.FC<{
    children: ReactNode;
    onClick?: () => void;
    variant?: 'default' | 'primary' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    style?: CSSProperties;
  }>;

  export const EmptyState: React.FC<{
    icon?: ReactNode;
    title: string;
    description?: string;
    action?: ReactNode;
    style?: CSSProperties;
  }>;
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
