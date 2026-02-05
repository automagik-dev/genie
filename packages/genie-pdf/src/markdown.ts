import { marked, type Token, type Tokens } from "marked";
import matter from "gray-matter";

export interface ParsedMarkdown {
  frontmatter: {
    title?: string;
    author?: string;
    date?: string;
    theme?: string;
    [key: string]: unknown;
  };
  tokens: Token[];
  hasTOC: boolean;
  headings: HeadingInfo[];
}

export interface HeadingInfo {
  level: number;
  text: string;
  id: string;
}

function generateId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function parseMarkdown(content: string): ParsedMarkdown {
  const { data: frontmatter, content: markdownContent } = matter(content);

  // Check for TOC marker
  const hasTOC = markdownContent.includes("[TOC]");
  const cleanedContent = markdownContent.replace(/\[TOC\]/g, "");

  // Parse markdown to tokens
  const tokens = marked.lexer(cleanedContent);

  // Extract headings for TOC
  const headings: HeadingInfo[] = [];
  for (const token of tokens) {
    if (token.type === "heading") {
      const headingToken = token as Tokens.Heading;
      headings.push({
        level: headingToken.depth,
        text: headingToken.text,
        id: generateId(headingToken.text),
      });
    }
  }

  return {
    frontmatter,
    tokens,
    hasTOC,
    headings,
  };
}

export type { Token, Tokens };
