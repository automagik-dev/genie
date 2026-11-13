# Header

The site's top bar: the logo, the three menus and one small primary button. It stays at the top of every page, on a see-through `bg` with a `line` under it.

- The logo is the lockup with the three-colour triskle, in its **header drawing** (the files ending `-header`): ink letters on the light theme, cream letters on the dark one. Shown here 36px high. Never set it under 28px high.
- It points at one file per theme. When the wordmark changes, replace those files under the same names; nothing here changes.
- Menu buttons use `label-nav`. The current section's button carries `data-here` and sits on `bt-active`.
- Under 860px wide the menus fold into one "Menu" button.
- The bar is 72px high (64px on a phone); the site keeps that in `--top-h` on `.top`.
