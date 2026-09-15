/**
 * Sidebar glyphs in the DSH primitive style: 16-unit viewBox, 1.5px strokes,
 * currentColor, `size` prop. Drawn to sit beside IconSkillOutline16 and friends.
 */
import type { ReactElement } from 'react';

interface IconProps {
  size?: number | undefined;
  className?: string | undefined;
}

const frame = (size: number, className: string | undefined, children: ReactElement | ReactElement[]) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Kanban: three columns with cards. */
export const IconBoard16 = ({ size = 16, className }: IconProps) =>
  frame(size, className, [
    <rect key="f" x="1.75" y="2.25" width="12.5" height="11.5" rx="2" />,
    <path key="c" d="M5.9 2.5v11M10.1 2.5v11" />,
    <path key="k" d="M3.4 5h1M7.5 5h1M11.6 5h1M3.4 7.5h1M7.5 7.5h1M3.4 10h1" />,
  ]);

/** Skill: a document with a sparkle, echoing DSH's own skill glyph. */
export const IconSkills16 = ({ size = 16, className }: IconProps) =>
  frame(size, className, [
    <path key="d" d="M9.5 14.25H4.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5h5.75a1.5 1.5 0 0 1 1.5 1.5V8" />,
    <path key="l" d="M5 5.5h4M5 8h3" />,
    <path
      key="s"
      d="M12.25 9.5l.6 1.65 1.65.6-1.65.6-.6 1.65-.6-1.65-1.65-.6 1.65-.6z"
      fill="currentColor"
      stroke="none"
    />,
  ]);

/** Workflow: nodes connected in a fan-out. */
export const IconWorkflows16 = ({ size = 16, className }: IconProps) =>
  frame(size, className, [
    <rect key="a" x="1.75" y="6.25" width="3.5" height="3.5" rx="1" />,
    <rect key="b" x="10.75" y="2.25" width="3.5" height="3.5" rx="1" />,
    <rect key="c" x="10.75" y="10.25" width="3.5" height="3.5" rx="1" />,
    <path
      key="e"
      d="M5.25 8h2.5c.75 0 1.25-.5 1.25-1.25V5.5c0-.75.5-1.5 1.25-1.5h.5M7.75 8h1.25c.75 0 1.25.5 1.25 1.25v1.25c0 .75.5 1.5 1.25 1.5h-.75"
    />,
  ]);
