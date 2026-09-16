// Hand-maintained declarations for the subset of @deepseek-ai/dsh-client-ui-primitives
// the Genie plugin uses. Runtime values come from DSH's frozen browser module table; React types come from @types/react (devDependency, typecheck only).
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
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
export function Input(
  props: { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>,
): JSX.Element;
export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger';
export function Tag(props: { tone?: TagTone; className?: string; children: ReactNode }): JSX.Element;
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';
export function StateDot(props: { state: StateDotState; size?: number; className?: string }): JSX.Element;
export interface IconProps {
  size?: number | undefined;
  className?: string | undefined;
}
export function IconSkillOutline16(props: IconProps): JSX.Element;
export function IconRefreshOutline16(props: IconProps): JSX.Element;
export function IconPlusOutline16(props: IconProps): JSX.Element;
export function IconSearchOutline16(props: IconProps): JSX.Element;
