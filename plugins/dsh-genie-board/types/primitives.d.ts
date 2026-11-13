// Hand-maintained declarations for the subset of @deepseek-ai/dsh-client-ui-primitives
// the Genie plugin uses. Runtime values come from DSH's frozen browser module table; React types come from @types/react (devDependency, typecheck only).
// Compared against the real declarations of 0.2.2-rc.2 (lib/types/{Button,Tag,StateDot}.d.ts, icons/index.d.ts).
import type { ButtonHTMLAttributes, ReactNode } from 'react';
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';
export function Button(
  props: {
    variant?: ButtonVariant;
    size?: 'md' | 'sm';
    icon?: ReactNode;
    className?: string;
    children?: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>,
): JSX.Element;
export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger';
export function Tag(props: { tone?: TagTone; className?: string; children: ReactNode }): JSX.Element;
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';
export function StateDot(props: { state: StateDotState; size?: number; className?: string }): JSX.Element;
export interface IconProps {
  size?: number | undefined;
  className?: string | undefined;
}
type Icon = ((props: IconProps) => JSX.Element) | undefined;
// Each action icon under both names a Host's table has carried, and neither one is
// promised: `IconXOutline16` up to 0.1.6-alpha.2, `IconXOutlineRegular` from
// 0.1.7-alpha.1, with no alias. src/client/icons.tsx reads the current name first.
export const IconRefreshOutlineRegular: Icon;
export const IconRefreshOutline16: Icon;
export const IconPlusOutlineRegular: Icon;
export const IconPlusOutline16: Icon;
export const IconSearchOutlineRegular: Icon;
export const IconSearchOutline16: Icon;
