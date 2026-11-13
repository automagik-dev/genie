# Favicon

The mark for browser tabs and home screens. Three colours, because they hold on a light and on a dark browser theme.

- `favicon.ico`: 16, 32 and 48px. `favicon.svg`: the drawing for small sizes.
- `apple-touch-icon.png` (180px), `icon-192.png`, `icon-512.png`: the mark on the plum ground, safe when cut to a circle.
- `favicon-16.png`, `-32.png`, `-48.png`: the pictures inside the .ico.
- `alternates/`: the app icons on cream, and the one-colour fallback.

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
