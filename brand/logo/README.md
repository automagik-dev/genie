# Logo

The triskle is Automagik's mark, and Automagik's alone. It is the owner's clay render with one clear line along the seams. Genie, Omni and Mykes show as their word until the owner approves a mark for each (the README's rules 1, 9 and 10).

## The mark: `svg/` and `png/`

- **`triskle-three-colours` is the mark.** `triskle-ink` (for light grounds) and `triskle-cream` (for dark grounds) are the fallback where colour cannot be used.
- `svg/triskle-<colour>.svg`: the large drawing, from about 100px up. `-64`, `-32`, `-16`: the drawings for those sizes, with a wider line.
- `png/triskle-<colour>-1024.png` and `-512.png`: clear ground. Other sizes: `../export-png.mjs`.
- All files share one square frame, so they line up when swapped.
- These are pictures, not single-ink shapes: CSS `color` does not change them. Pick the colour by file.

## Lockups: `lockups/`

The mark with the wordmark, for `automagik`.

**The `genie-lockup-*` and `omni-lockup-*` files are RETIRED.** They carry the triskle, which is Automagik's alone. Do not use them: Genie and Omni show as their wordmark. The files stay here for older work that points at them, and they are not to be changed.

The notes below are for Automagik's lockup; the retired files were built the same way, in the same frame.

- **`automagik-lockup-three-colours-ink` and `-three-colours-cream` are the lockups.** Ink letters for light grounds, cream letters for dark grounds.
- `-header`: the same with the wider seam line, for a lockup under about 56px high.
- `automagik-lockup-ink` and `-cream`: the one-colour fallback.
- The dot on the i is a sparkle in the product's colour: Automagik's is violet, Genie's is pink and Omni's is cyan. It is 60 units across where the small letters are 100 high.

## Wordmark: `wordmark/`

The name alone, in the approved round lowercase lettering, with the product's sparkle on the i. The letters are outlines; no font is needed. This is how Genie, Omni and Mykes show, with no mark beside the word (the README's rule 10).

- One file per name and letter colour: `-ink` for light grounds, `-cream` for dark grounds.
- The files are as high as the lockup frame, so a wordmark and a lockup at one height have letters of one size.
- **This is the one place the lettering is drawn.** The lockups are built from these files. To change the wordmark, replace these files under the same names and rebuild the lockups.
