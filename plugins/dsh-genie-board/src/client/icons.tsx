/**
 * Every icon the panels draw. The two sidebar glyphs are drawn here in the DSH
 * primitive style (16-unit viewBox, 1.5px strokes, currentColor, `size` prop); the
 * three action glyphs come from the Host's own primitives table.
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactElement } from 'react';

interface IconProps {
  size?: number | undefined;
  className?: string | undefined;
}

type Glyph = (props: IconProps) => ReactElement | null;
const noGlyph: Glyph = () => null;

/*
 * `@deepseek-ai/dsh-client-ui-primitives` 0.1.7-alpha.1 renamed every `IconXOutline16`
 * to `IconXOutlineRegular` / `IconXOutlineMedium` with no alias, and the range this
 * plugin declares spans both sides of that rename. Each action glyph is therefore read
 * from the namespace, the current name first and the earlier one second: a name the
 * Host's frozen module table does not carry reads as `undefined` there, and rendering
 * `undefined` is what failed both panels on first render from 0.1.7-alpha.1 until this
 * fix. A table with neither name draws no glyph; every call site keeps its text
 * (Refresh, Add, No match), so none of them is ever an icon-only control.
 */
export const IconRefresh: Glyph = primitives.IconRefreshOutlineRegular ?? primitives.IconRefreshOutline16 ?? noGlyph;
export const IconPlus: Glyph = primitives.IconPlusOutlineRegular ?? primitives.IconPlusOutline16 ?? noGlyph;
export const IconSearch: Glyph = primitives.IconSearchOutlineRegular ?? primitives.IconSearchOutline16 ?? noGlyph;

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
