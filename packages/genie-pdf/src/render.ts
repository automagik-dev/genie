import React from "react";
import { renderToFile } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { parseMarkdown } from "./markdown.js";
import { getTheme, type ThemeConfig } from "./themes/index.js";
import { Document, Markdown, TOC } from "./components/index.js";

export interface RenderOptions {
  input: string;
  output: string;
  theme?: string;
  showPageNumbers?: boolean;
}

function toOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

export async function renderMarkdownToPDF(options: RenderOptions): Promise<void> {
  const { input, output, theme: themeName = "default", showPageNumbers = true } = options;

  // Read input file
  const content = await Bun.file(input).text();

  // Parse markdown
  const parsed = parseMarkdown(content);

  // Get theme (CLI option overrides frontmatter)
  const effectiveTheme = themeName || parsed.frontmatter.theme || "default";
  const theme = getTheme(effectiveTheme);

  // Build children array
  const children: React.ReactNode[] = [];

  if (parsed.hasTOC) {
    children.push(
      React.createElement(TOC, {
        key: "toc",
        headings: parsed.headings,
        theme,
      })
    );
  }

  children.push(
    React.createElement(Markdown, {
      key: "content",
      tokens: parsed.tokens,
      theme,
    })
  );

  // Create document
  const doc = React.createElement(
    Document,
    {
      title: toOptionalString(parsed.frontmatter.title),
      subtitle: toOptionalString(parsed.frontmatter.subtitle),
      author: toOptionalString(parsed.frontmatter.author),
      date: toOptionalString(parsed.frontmatter.date),
      theme,
      showPageNumbers,
      children,
    }
  );

  // Render to file - cast to satisfy @react-pdf/renderer types
  await renderToFile(doc as unknown as ReactElement, output);
}

export async function renderTemplateToPDF(
  templateName: string,
  data: unknown,
  output: string,
  theme: ThemeConfig
): Promise<void> {
  // Dynamic import of template
  const templatePath = `./templates/${templateName}.js`;
  try {
    const templateModule = await import(templatePath);
    const TemplateComponent = templateModule.default;

    const doc = React.createElement(TemplateComponent, {
      data,
      theme,
    });

    // Render to file - cast to satisfy @react-pdf/renderer types
    await renderToFile(doc as unknown as ReactElement, output);
  } catch (error) {
    throw new Error(`Template "${templateName}" not found`);
  }
}
