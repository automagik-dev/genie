# Rendered interface lens

This lens applies only when the change under review touches a rendered interface of the project; a project with no user interface never loads it. Review stays read-only here: navigate, capture, read the console, and take what the runtime already renders, leaving every form unsubmitted and every stored value as it was found. A claim about how a screen looks is worth exactly as much as the frame that carries it.

## Evidence to collect

- Exploring an unfamiliar interface: the console read after every navigation and after every interaction, because an error the screen itself announces nowhere is among the most valuable findings; an annotated element reference or a captured frame standing behind each observation; the symptom reproduced before it is written down; the full scroll extent and each multi-step flow walked to its end, since below-the-fold and late-step rendering differ from the first viewport.
- Coverage across the axes a screen fails on separately: function, layout and style, accessibility, console, interaction, content.
- Comparing against a pinned reference: the reference pinned by path, revision, or checksum somewhere every later reader resolves it, because a local untracked drop is invisible to a child worktree; reference and implementation captured under one stated environment — viewport, device scale factor, theme, locale, clock, fonts, fixtures, motion setting, scroll position — with each compared scene named.
- The oracle's own capability, because a comparison that cannot go red proves nothing: one altered token, one altered static label, one altered dimension, and the gate failing on each.
- Where the runtime cannot render the interface at all, the finding is literally `rendering unavailable: gap reported, no visual claim made`, and nothing about appearance is asserted from source.

## Traps

- Functional equivalence is not visual fidelity: routes, labels, data, and actions can all be right while shell, palette, typography, density, spacing, imagery, or composition came from another design system.
- Reading a flow in the source and recording it as exercised, or inferring appearance from component names and test counts.
- Reporting a rendered defect with no captured frame behind it.
- Comparing screens whose data and clock still move, or masking regions until the remaining difference means nothing.
- Downgrading a reference to "directional" after exact fidelity was asked for, or leaving both the inherited component and the reference version of one surface mounted.
- Reaching past observation into a submitted form, an authenticated path, or stored state; the reviewer captures what is already rendered and reports the gap instead.

Rank by what a user meets first and how visibly it fails, scoring every finding on review's own severity table and verdict vocabulary; each one names the frame or reference scene it came from.
