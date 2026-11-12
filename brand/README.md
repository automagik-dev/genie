# Automagik brand

Automagik is one product family: Automagik, Genie and Omni. This folder is how it looks: one mark, one lettering, a cream and plum theme, soft clay shapes. Everything here was approved by the owner; nothing was added.

It is documentation. No build, app or release reads this folder.

## The rules

1. **The mark is always the triskle.** Automagik, Genie and Omni all carry the same mark. There is no other logo.
2. **The triskle is always in colour.** Cyan, pink and violet, as in the clay. The ink and cream marks are a fallback only, for places where colour cannot be used: one-colour print, engraving, a single-ink stamp.
3. **Pets are never marks.** Genie and Omni are characters. They never stand in for the logo, in a header, a favicon or an app icon.
4. **The only Genie is the full-body one.** The head alone is retired.
5. **One letter size for every product.** The three lockups share one frame: at the same height the mark and the letters are the same size in all three.
6. **A drawing made for each size.** The mark has a thin clear line along its seams, and that line is drawn again for small sizes. Pick the file made for the size you show; never scale the large drawing down to an icon.
7. **The dot on the i is a sparkle, one colour per product.** One four-point star with the same area as the round dot it replaced, in one of the mark's three colours: Automagik's is violet, Genie's is pink and Omni's is cyan. The triangle stands for the three products.
8. **Never redraw it.** Do not move, reshape, slim, recolour or outline the mark's pieces, the letters or Genie. Use the files.

## What is here

| Folder | What it holds |
| --- | --- |
| `logo/svg/` | The triskle, in three colours (the mark) and in ink and cream (the fallback), with a drawing for each size |
| `logo/png/` | The mark at 1024 and 512px, clear ground |
| `logo/lockups/` | The mark with the wordmark, for automagik, genie and omni |
| `logo/wordmark/` | The name alone |
| `favicon/` | The browser tab and home screen set |
| `genie/` | The one Genie |
| `tokens/` | The colours in both themes, type, radius, shadow and layout values, as `tokens.json` and `tokens.css` |
| `fonts/` | Fredoka, the title face, with its licence and where it came from |
| `components/` | The site's components: their stylesheet, a note and a preview page each |
| `export-png.mjs` | Makes a PNG from any SVG here |

## Which logo file

| Where | File |
| --- | --- |
| A header or footer, on a light ground | `logo/lockups/automagik-lockup-three-colours-ink-header.svg` |
| A header or footer, on a dark ground | `logo/lockups/automagik-lockup-three-colours-cream-header.svg` |
| A cover, a slide, print: 120px high or more | `logo/lockups/automagik-lockup-three-colours-ink.svg` or `-cream.svg` |
| Genie or Omni | the same four files, starting `genie-` or `omni-` |
| The mark alone, 100px or more | `logo/svg/triskle-three-colours.svg` |
| The mark alone at about 64, 32 or 16px | `logo/svg/triskle-three-colours-64.svg`, `-32.svg`, `-16.svg` |
| A browser tab | `favicon/favicon.ico` and `favicon/favicon.svg` |
| A phone's home screen, a web manifest | `favicon/apple-touch-icon.png`, `favicon/icon-192.png`, `favicon/icon-512.png` |
| The name without the mark | `logo/wordmark/automagik-wordmark-ink.svg` or `-cream.svg` |
| Colour cannot be used | the files with `-ink` or `-cream` and no `three-colours` in the name |

- "ink" means ink letters, for light grounds. "cream" means cream letters, for dark grounds.
- Keep clear space around the lockup of at least the height of its small letters.
- Do not set the lockup under 28px high. From about 36px the dot reads as a sparkle; under that it is a soft plus, which is fine.
- The grounds the logo was drawn for are `bt-main` in its light and its dark value. On a photo or a strong colour, put it on one of those first.
- The SVGs use masks and blur. Every current browser draws them. For a tool that does not (some slide and print tools), use a PNG.
- **The wordmark is one file per name and letter colour.** The lettering is drawn there and in the lockups built from it, and nowhere else. Components point at a file and never carry the letters themselves, so a change to the wordmark is a change of files under the same names.

## PNG files

Only the mark at 1024 and 512px is kept here as PNG. Every other PNG is made from an SVG with `export-png.mjs`. The SVGs use masks and blur, so the script draws them in a browser: it needs `playwright-core` (in the root `package.json`) and a Chromium, either the one playwright installs (`bunx playwright-core install chromium`) or your own, with its path in `BRAND_CHROME`.

```sh
node docs/brand/export-png.mjs <file.svg> <height in px> [out.png]
```

Pick the drawing made for the size:

| PNG | From |
| --- | --- |
| The mark, 128px and up | `logo/svg/triskle-<colour>.svg` |
| The mark at 64, 32 or 16px | `logo/svg/triskle-<colour>-64.svg`, `-32.svg`, `-16.svg` |
| A lockup 128px high and up | `logo/lockups/<name>-lockup-<kind>.svg` |
| A lockup 64px high or less | `logo/lockups/<name>-lockup-<kind>-header.svg` |

```sh
node docs/brand/export-png.mjs docs/brand/logo/svg/triskle-three-colours.svg 256
node docs/brand/export-png.mjs docs/brand/logo/lockups/automagik-lockup-three-colours-ink-header.svg 48
```

## Colour

- The page is `bt-main`: cream by day, plum at night. Text is `bt-ink`; secondary text is `muted`.
- Surfaces step up from the page: `st-raised`, then `st-paper` for cards, menus and sheets. `st-sunk` steps down.
- Edges are hairlines, `st-line` and `st-line-2`. There are no heavy borders.
- One accent, `bt-accent`, for links and small details. Focus is always the `st-ring` outline: 3px, 3px off the edge.
- Three tints carry the mood: `st-cyan`, `st-lilac` and `bt-user` (pink). Each has its own text colour. Together they make the stage, the soft cyan to lilac to pink gradient behind art.
- `triskle-cyan`, `triskle-pink` and `triskle-violet` are the mark's own colours. They live in the mark and in brand art. They are never text and never a UI colour.
- Status has four colours: `st-ok`, `st-bad`, `st-warn` and `st-work`, with `st-okdot` and `st-warndot` for dots. Colour never carries a status alone: every status dot has a word or a mark beside it. The four are set apart in lightness, so red-blind, green-blind and blue-blind sight can tell them apart, but some pairs stay close without the word.
- Each colour's note names the grounds it is legible on. Every text and ground pair named there passes 4.5:1 in both themes.
- The site's stylesheet also uses short names (`bg`, `paper`, `text`, `line`, `accent`, `ring`); they point at the tokens above.

## Type

- Two families. **Fredoka** for titles, labels and buttons. **DM Sans** for running text at weight 400. The logo's letters are their own drawing, not a font: never set a logo in Fredoka.
- Fredoka is round, with one even stroke, like the logo's letters. It is set at the logo's weight: the logo's stroke is 26.5% of its small letters' height, and Fredoka has that at weight 536. That is `weight-title`. Buttons, links and card titles use `weight-strong` (469); menu items use `weight-label` (402). Use these three weights only: a heavier Fredoka is heavier than the logo.
- Titles have a little negative letter spacing (`-0.02em` for the page title, `-0.016em` for section titles, `-0.01em` for card titles). Fredoka is drawn tight; do not tighten it more. Its word space is wide already: titles take no extra word spacing.
- Titles are large; the line under them is light and calm. Eyebrows and small labels are capitals with wide tracking.
- The page title, section titles and the intro line are fluid on the site. The styles here record their largest size; each note gives the full rule.
- Code uses the reader's own monospace face.

Fredoka's file is `fonts/fredoka-latin.woff2`, with its licence beside it (SIL Open Font License 1.1) and its source in `fonts/README.md`. Serve that file yourself; do not load the face from a font service. Its `@font-face` rule carries `size-adjust:105%`, which keeps its lines as long as those of the face it replaced, so titles break where they did; copy the rule from `tokens/tokens.css`. DM Sans is the site's file, `apps/landing/assets/brand/dm-sans-latin.woff2`; `tokens/tokens.css` loads it from there.

## Shape, depth and space

- Corners are generous: `radius` (28px) for cards, `st-r-stage` for the stage, `st-r-dialog` for dialogs and sheets, `st-r-menu` for menus, `st-r-seg` for small controls. Pills are fully round.
- Depth is soft and warm. `st-lift` raises a card on hover. `st-clay` is the clay press. `st-hollow` presses in. `shadow-window` sits under app windows, menus and sheets.
- The site has no spacing scale. It has a page width, `max` (1200px), and a fluid side gutter, `gutter` (20px on a phone to 56px on a wide screen). Space inside components is set per component.

## Genie

Genie is a character, not a logo. There is one Genie: the full-body clay figure, with the magenta plume, the cyan smile and the night-sky tail.

- Use `genie/genie-full-body.png` (1254px, clear ground). `genie/genie-avatar-256.webp` is the same figure at 256px, for a chat avatar.
- Never crop to the head. Never redraw, recolour or restyle.
- Genie never takes the mark's place.

## Tokens

`tokens/tokens.json` is the record; `tokens/tokens.css` is the same values as CSS custom properties, light and dark. The colours, shadows, radii and sizes were read from the site's own files, `apps/landing/theme.css` and `apps/landing/styles.css`, at `dev@6ba09b59`; when the theme changes there, these files are made again from it. The title face goes the other way: its family, its three weights and its font file are set here, and the site takes them from this folder (`node apps/landing/scripts/sync-theme.mjs` writes the site's theme and copies the font; its `--check` fails when they differ).

Setting `data-theme="light"` or `data-theme="dark"` on the root picks a theme. With neither, the reader's system setting picks.

## Components

The components are the site's own, in its own stylesheet with the token declarations taken out (`components/bundle.css`). They are plain HTML and CSS; there is no script. Each folder holds a note (when to use it, what it needs) and `preview.html`, a page that shows it; open the page in a browser from a checkout.

- `components/Header/`: The site's top bar: the logo, the three menus and one small primary button. It stays at the top of every page, on a see-through `bg` with a `line` under it.
- `components/Footer/`: The site's footer: the logo with one line about the product, three columns of links, and the licence line. It sits on `raised` with a `line` on top.
- `components/Menu/`: The panel a header menu opens: a `paper` card with a list of destinations and a quiet foot line.
- `components/Crumbs/`: The way back on a product page: "All products", then the page's name. Small `head` text in `muted`; the current page is in `text`.
- `components/Pager/`: The way on at the foot of a product page: the previous product, a link to all of them, the next product.
- `components/Button/`: Two buttons. **Primary** is flat ink (`text`) with `bg`-coloured words and a soft press: one per view, for the thing the page is for. **Secondary** is `paper` with a `line-2` border.
- `components/GetTray/`: "Get Automagik for": a row of platform chips. A live platform is a button that opens its Sheet; a platform that is not ready yet is shown as text with a "soon" mark, never as a dead button.
- `components/Sheet/`: The download sheet a platform chip opens: what you get, the exact file, what it needs, how to install it, and one primary button.
- `components/HeroHeading/`: The top of a product page: an eyebrow, the page title, one intro line, the actions, and a line of fine print.
- `components/ProductCard/`: One product on the home page's grid: a tag, the product's name, one or two lines, a detail link, and its art.
- `components/SoonPill/`: "Coming soon": a small pill for a product that is not out yet. `st-lilac` ground, `st-lilac-ink` capitals. It is a label, not a button.
- `components/WaitlistForm/`: The interest form on the Cloud page: labelled fields, a consent line, one primary button and a line of fine print.

Start a page with Header and end it with Footer. Use one primary Button per view.

## Not here

These are on the site but are not part of this folder:

- **App captures and product art** in the window and phone frames, and the frames themselves. They are pictures of the product, not brand files.
- **The site's own copies of the logo.** The site carries a few files of this set under `apps/landing/assets/brand/`; the full set is here. Its `lamp.webp` and its lockup with the Open Intelligence tag are not part of the set.
- **The Open Intelligence tag** and the IBM Plex Mono face it is set in. They are we unfold's.
- **Omni's art and the pet art.** No approved file for them is in this set, and pets are never marks.
- **Other projects' marks** in the "made possible by" row, and Arca's logo.
- **The home page's layouts**: the hero with the cast, the grid's arrangement, the phone menu.
- **Motion.** The site's motion rules are in the component stylesheet; there are no motion tokens.
- **The stage gradient and the three tile colours.** They are a gradient and colour mixes, which a token cannot hold; they are in the component stylesheet as `--st-stage`, `--tile-cyan`, `--tile-lilac` and `--tile-pink`.
- **Some app-only tokens** are in the theme but unused by the site's pages; their notes say so.

## Using this in another repository

Genie, Omni and Arca carry a byte copy of this folder, with the agents' skill (`.claude/skills/automagik-brand/`) and the tool that makes the copy (`scripts/brand-sync.mjs`). Automagik's repository is the source. A copy is never edited: a change is made in Automagik's repository and copied again. In a copy the folder is `docs/brand/` too, unless `--into` names another: a repository whose `docs/` is not its own folder keeps the brand in `brand/`, for example. `SOURCE.json` exists only in a copy, beside the skill (`.claude/skills/automagik-brand/SOURCE.json`). It records the folder the brand is in (`into`), the Automagik commit the copy was made from and the sha256 of every copied file.

```sh
node scripts/brand-sync.mjs --write --from <an Automagik checkout, or a commit> [--into <folder>]
node scripts/brand-sync.mjs --check
```

- `--write` copies the files as they are committed at that commit, removes the files the source no longer has, and writes `SOURCE.json`. A repository with no copy yet runs the tool from an Automagik checkout, from its own folder: `node <checkout>/scripts/brand-sync.mjs --write --from <checkout>`.
- `--into <folder>` names the brand's folder in that repository, from its root. It is given once: later runs, and the skill, read the folder from `SOURCE.json`. Given again with another folder, it moves the copy there. A folder named for the first time must not hold other files.
- A copy made before the folder could be chosen has its `SOURCE.json` in `docs/brand/`. It is still read, and the next `--write` moves it beside the skill.
- A copy made from `6ba09b59` holds `docs/brand/fonts/rebuild/`, which the next `--write` removes. If `npm ci` was run there, as that commit's notes said, its `node_modules/` holds symbolic links (`.bin`), and `--write` refuses on them: remove that `node_modules/` folder first, then run `--write`.
- `--check` is for that repository's CI. It exits 1 and names each file that differs from `SOURCE.json`, is missing, or is not recorded.
- Both then look at Automagik's `dev`. When the brand changed there after the copy's commit, they name `dev`'s commit to copy. When the copy was made from a commit that is not on `dev` (a branch), they say that and do not advise copying `dev` over it. `--check` warns for either and does not fail. With no network they say so and go on.
- A copy holds real folders and files only. When a file of the copy, `SOURCE.json`, or a folder on the way to one is a symbolic link, `--write` refuses before it changes anything and `--check` fails naming the link.
- Fredoka's file is in this folder (`fonts/`), so a copy has the title face. DM Sans's file is not (see "Type"): for running text `tokens/tokens.css` falls back to the reader's own faces until the repository carries that file at the path the rule names.
