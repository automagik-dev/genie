---
title: Genie PDF Documentation
author: Genie Labs
date: 2024-01-15
theme: default
---

[TOC]

# Introduction

Welcome to **genie-pdf**, a powerful CLI tool for generating beautiful PDFs programmatically. This document showcases the various features available.

## Why genie-pdf?

When agents need to generate professional documents, they need a tool that:

- Works from the command line
- Accepts structured input (Markdown, JSON)
- Produces consistent, professional output
- Supports customization via themes

## Quick Start

Getting started is simple:

```bash
bun run src/index.ts render doc.md -o output.pdf
```

# Features

## Markdown Support

genie-pdf supports the full Markdown syntax:

### Text Formatting

You can use **bold text**, *italic text*, and `inline code`. Combine them for **_bold italic_** text.

### Lists

Unordered lists:

- First item
- Second item
- Third item with more details

Ordered lists:

1. Step one
2. Step two
3. Step three

### Code Blocks

Here's an example TypeScript function:

```typescript
async function renderPDF(input: string, output: string) {
  const content = await Bun.file(input).text();
  const parsed = parseMarkdown(content);
  await renderToFile(doc, output);
}
```

### Tables

| Feature | Status | Notes |
|---------|--------|-------|
| Headers | ✅ | h1-h4 supported |
| Lists | ✅ | Ordered and unordered |
| Code | ✅ | Inline and blocks |
| Tables | ✅ | Basic tables |
| Images | ✅ | Local and remote |

### Blockquotes

> "The best way to predict the future is to create it."
> — Peter Drucker

## Themes

Choose from several built-in themes:

- **default** — Clean, professional blue
- **minimal** — Simple black and white
- **corporate** — Formal business style
- **dark** — Dark mode (experimental)

## Templates

Pre-built templates for common use cases:

1. **report** — Business reports
2. **invoice** — Professional invoices
3. **research** — Academic papers
4. **resume** — CVs and resumes

# Conclusion

genie-pdf makes it easy for agents to generate professional PDFs without manual design work. The combination of Markdown input, customizable themes, and pre-built templates covers most document generation needs.

---

*Generated with genie-pdf v0.1.0*
