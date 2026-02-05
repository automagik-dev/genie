---
name: genie-pdf
description: Generate professional PDFs programmatically from markdown, JSON templates, or structured data. Use when creating invoices, reports, resumes, research papers, or any document that needs clean PDF output.
---

# genie-pdf

CLI tool for generating beautiful PDFs programmatically. Input markdown or JSON template data, output professional PDFs.

## Location

```
/home/genie/workspace/guga/code/genie-pdf
```

## Quick Start

```bash
cd /home/genie/workspace/guga/code/genie-pdf

# Render markdown to PDF
bun run src/index.ts render doc.md -o output.pdf

# Use a template with JSON data
bun run src/index.ts template invoice --data invoice.json -o invoice.pdf

# List available templates
bun run src/index.ts templates

# List available themes
bun run src/index.ts themes
```

## Commands

### render

Convert markdown to PDF.

```bash
bun run src/index.ts render <input.md> -o <output.pdf> [options]
```

Options:
- `-o, --output` - Output PDF path (required)
- `--theme` - Theme name (default, minimal, corporate, dark)
- `--no-page-numbers` - Disable page numbers
- `--watch` - Watch mode for live updates

### template

Generate PDF from a template with JSON data.

```bash
bun run src/index.ts template <template-name> --data <data.json> -o <output.pdf>
```

Available templates:
- `invoice` - Professional invoice with line items
- `report` - Business report with sections
- `resume` - CV/resume format
- `research` - Academic paper format

## Themes

| Theme | Description |
|-------|-------------|
| default | Clean blue professional look |
| minimal | Black and white, simple |
| corporate | Formal business style |
| dark | Dark background (experimental) |

## Template Data Formats

### invoice

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
    { "description": "Service A", "quantity": 10, "unitPrice": 100 }
  ],
  "currency": "R$",
  "notes": "Thank you!"
}
```

### report

```json
{
  "title": "Q4 Report",
  "subtitle": "Annual Review",
  "author": "John Doe",
  "date": "2024-01-15",
  "summary": "Executive summary...",
  "sections": [
    { "title": "Introduction", "content": "..." }
  ]
}
```

### resume

```json
{
  "name": "John Doe",
  "title": "Software Engineer",
  "email": "john@example.com",
  "phone": "+1 234 567 8900",
  "location": "San Francisco, CA",
  "summary": "Experienced engineer...",
  "experience": [
    {
      "title": "Senior Engineer",
      "company": "Tech Corp",
      "startDate": "2020",
      "endDate": "Present",
      "highlights": ["Built X", "Led Y"]
    }
  ],
  "education": [
    { "degree": "BS CS", "institution": "MIT", "date": "2016" }
  ],
  "skills": ["TypeScript", "React"]
}
```

### research

```json
{
  "title": "A Study on...",
  "authors": ["Author One", "Author Two"],
  "institution": "University Name",
  "abstract": "This paper presents...",
  "keywords": ["keyword1", "keyword2"],
  "sections": [
    { "title": "Introduction", "content": "..." }
  ],
  "references": [
    "Author (2023). Title. Journal."
  ]
}
```

## Markdown Features

### Frontmatter

```markdown
---
title: My Document
author: John Doe
date: 2024-01-15
theme: corporate
---

# Content
```

### Table of Contents

Add `[TOC]` to generate automatic TOC:

```markdown
[TOC]

# Section 1
# Section 2
```

### Supported Syntax

- Headers (h1-h4)
- **Bold** and *italic*
- Code blocks with syntax highlighting
- Links and images
- Tables
- Blockquotes
- Lists (ordered/unordered)
- Horizontal rules

## Workflow Example

```bash
# 1. Create invoice data
cat > invoice-data.json << 'EOF'
{
  "invoiceNumber": "INV-2024-001",
  "date": "2024-01-15",
  "dueDate": "2024-02-15",
  "from": { "name": "Automagik", "address": "São Paulo, BR" },
  "to": { "name": "Client Corp", "address": "NYC, USA" },
  "items": [
    { "description": "AI Development", "quantity": 40, "unitPrice": 150 }
  ],
  "currency": "USD"
}
EOF

# 2. Generate PDF
bun run src/index.ts template invoice --data invoice-data.json -o invoice.pdf

# 3. Check output
ls -la invoice.pdf
```

## Development

```bash
cd /home/genie/workspace/guga/code/genie-pdf

# Install deps
bun install

# Type check
bun run typecheck

# Test render
bun run src/index.ts render templates/example.md -o test.pdf
```

## Stack

- **Runtime:** Bun
- **PDF:** @react-pdf/renderer
- **Styling:** react-pdf-tailwind
- **CLI:** Commander.js
- **Markdown:** marked + gray-matter
