# genie-pdf

CLI tool for agents to generate beautiful PDFs programmatically. Input markdown/JSON/structured text, output professional PDFs.

## Installation

```bash
bun install
```

## Usage

### Render Markdown to PDF

```bash
# Basic
bun run src/index.ts render doc.md -o doc.pdf

# With theme
bun run src/index.ts render doc.md -o doc.pdf --theme corporate

# Without page numbers
bun run src/index.ts render doc.md -o doc.pdf --no-page-numbers

# Watch mode (re-render on changes)
bun run src/index.ts render doc.md -o doc.pdf --watch
```

### Use Templates

```bash
# Generate from template with JSON data
bun run src/index.ts template invoice --data invoice.json -o invoice.pdf

# List available templates
bun run src/index.ts templates
```

### List Available Options

```bash
# List themes
bun run src/index.ts themes

# List templates
bun run src/index.ts templates
```

## Themes

- **default** - Clean blue professional look
- **minimal** - Black and white, simple
- **corporate** - Formal business style
- **dark** - Dark background (experimental)

## Templates

### report

Business report with title page, summary, and sections.

```json
{
  "title": "Q4 Report",
  "subtitle": "Annual Review",
  "author": "John Doe",
  "date": "2024-01-15",
  "summary": "Executive summary...",
  "sections": [
    { "title": "Introduction", "content": "..." },
    { "title": "Analysis", "content": "..." }
  ]
}
```

### invoice

Professional invoice with line items.

```json
{
  "invoiceNumber": "INV-001",
  "date": "2024-01-15",
  "dueDate": "2024-02-15",
  "from": {
    "name": "Your Company",
    "address": "123 Street, City",
    "email": "billing@company.com"
  },
  "to": {
    "name": "Client Name",
    "address": "456 Avenue, City"
  },
  "items": [
    { "description": "Service A", "quantity": 10, "unitPrice": 100 },
    { "description": "Service B", "quantity": 5, "unitPrice": 200 }
  ],
  "currency": "R$",
  "notes": "Thank you for your business!"
}
```

### research

Academic paper format with abstract, sections, and references.

```json
{
  "title": "A Study on...",
  "authors": ["Author One", "Author Two"],
  "institution": "University Name",
  "date": "2024",
  "abstract": "This paper presents...",
  "keywords": ["keyword1", "keyword2"],
  "sections": [
    { "title": "Introduction", "content": "..." },
    { "title": "Methodology", "content": "..." }
  ],
  "references": [
    "Author (2023). Title. Journal.",
    "Author (2022). Title. Conference."
  ]
}
```

### resume

Professional CV/resume.

```json
{
  "name": "John Doe",
  "title": "Software Engineer",
  "email": "john@example.com",
  "phone": "+1 234 567 8900",
  "location": "San Francisco, CA",
  "website": "https://johndoe.com",
  "github": "johndoe",
  "linkedin": "johndoe",
  "summary": "Experienced engineer with...",
  "experience": [
    {
      "title": "Senior Engineer",
      "company": "Tech Corp",
      "location": "SF, CA",
      "startDate": "2020",
      "endDate": "Present",
      "highlights": ["Built X", "Led Y team"]
    }
  ],
  "education": [
    {
      "degree": "BS Computer Science",
      "institution": "MIT",
      "date": "2016"
    }
  ],
  "skills": ["TypeScript", "React", "Node.js"],
  "languages": [
    { "name": "English", "level": "Native" },
    { "name": "Spanish", "level": "Fluent" }
  ]
}
```

## Markdown Features

### Frontmatter

Use YAML frontmatter to set document metadata:

```markdown
---
title: My Document
author: John Doe
date: 2024-01-15
theme: corporate
---

# Content starts here
```

### Supported Syntax

- **Headers** (h1-h4)
- **Bold** and *italic* text
- `inline code` and code blocks with language highlighting
- [Links](https://example.com)
- Lists (ordered and unordered)
- Tables
- Blockquotes
- Images
- Horizontal rules

### Table of Contents

Add `[TOC]` anywhere in your markdown to generate an automatic table of contents.

```markdown
---
title: My Document
---

[TOC]

# Introduction
...

# Chapter 1
...
```

## Development

```bash
# Type check
bun run typecheck

# Run directly
bun run src/index.ts render example.md -o test.pdf
```

## Stack

- **Runtime:** Bun
- **PDF Generation:** @react-pdf/renderer
- **Styling:** react-pdf-tailwind
- **CLI:** Commander.js
- **Markdown:** marked + gray-matter
