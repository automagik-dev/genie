# Fonts

## Fredoka, the title face

| | |
| --- | --- |
| File | `fredoka-latin.woff2`: Latin and Latin Extended, the weight axis only (300 to 700), 30052 bytes |
| sha256 | `d1ceb16007127919aa1900fb85e4b5d612a4f242404a4068d43f3bc628b2aeca` |
| Licence | SIL Open Font License 1.1, in `OFL-Fredoka.txt`. Copyright 2016 The Fredoka Project Authors. The licence reserves no font name |
| Source | `ofl/fredoka/Fredoka[wdth,wght].ttf` in the Google Fonts repository (`github.com/google/fonts`), commit `2e5fa2e951237b6ae65f705693d12ca76a7f78c8`, version 2.001 |
| Source sha256 | `2ba02e68b152868aef9ba28e24b3648c7d457fe6f25c761f2c2c53fb61a73fc8` |

The file is made from the source with `subset-font` 2.9.0 (HarfBuzz): the characters of the Latin and Latin Extended ranges that Google Fonts serves, plus the arrow block where the face has it; the width axis fixed at 100; the weight axis kept whole; written as woff2. Nothing is redrawn. The face has no arrows (→ ↓ ↗): those fall to the next family in the stack.

### The exact call

`subset-font` 2.9.0 with `harfbuzzjs` 1.6.4, `fontverter` 2.0.0 and `wawoff2` 2.0.1 under it, on Node 24:

```js
subsetFont(input, text, { targetFormat: 'woff2', variationAxes: { wdth: 100, wght: { min: 300, max: 700 } } })
```

`input` is the source file above. `text` is 232 characters: every character the source has a glyph for, in this order of ranges, as one UTF-8 string (sha256 `c7224eaa525b085e4152125d5ad531bff915b4e24015089e7e598032cc09a8b3`):

- Latin: U+0020-007E, U+00A0-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD
- Latin Extended: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF
- Arrows: U+2190-2199 (the face has none)

With those versions the call gives this file byte for byte.

### Checked on every pull request

`scripts/brand-font/` in Automagik's repository holds the call as a script: `rebuild.mjs`, the characters in `text.txt`, and the four pinned packages in `package.json` and `bun.lock`. It is tooling, so it is outside this folder, which is copied whole into other repositories. CI's "Brand font rebuild" job downloads the source file at the commit above, checks its sha256, runs the script and fails unless the result is `fredoka-latin.woff2`, byte for byte. To run it yourself:

```
cd scripts/brand-font
bun install --frozen-lockfile --ignore-scripts
node rebuild.mjs "<path>/Fredoka[wdth,wght].ttf"
```

A new font file is a new source commit or a new text: change the script's two sha256 values with it, and the site's copy with `node apps/landing/scripts/sync-theme.mjs`.

Keep `OFL-Fredoka.txt` beside the font wherever it is copied. The licence lets you use, embed and bundle the font; it does not let you sell the font by itself.

The site serves its own copy, `apps/landing/assets/brand/fredoka-latin.woff2`. `node apps/landing/scripts/sync-theme.mjs` makes that copy from this folder, and its `--check` fails when the two differ.
