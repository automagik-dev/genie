import React from "react";
import { View, Text, Link, Image, StyleSheet } from "@react-pdf/renderer";
import type { Token, Tokens } from "../markdown.js";
import type { ThemeConfig } from "../themes/index.js";
import { CodeBlock } from "./CodeBlock.js";
import { Table } from "./Table.js";

interface MarkdownProps {
  tokens: Token[];
  theme: ThemeConfig;
}

export function Markdown({ tokens, theme }: MarkdownProps) {
  const styles = StyleSheet.create({
    h1: {
      fontFamily: theme.fonts.heading,
      fontSize: 24,
      color: theme.colors.heading,
      marginTop: theme.spacing.heading,
      marginBottom: 10,
    },
    h2: {
      fontFamily: theme.fonts.heading,
      fontSize: 18,
      color: theme.colors.heading,
      marginTop: theme.spacing.heading,
      marginBottom: 8,
    },
    h3: {
      fontFamily: theme.fonts.heading,
      fontSize: 14,
      color: theme.colors.heading,
      marginTop: theme.spacing.heading - 4,
      marginBottom: 6,
    },
    h4: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      color: theme.colors.heading,
      marginTop: theme.spacing.heading - 6,
      marginBottom: 4,
    },
    paragraph: {
      fontSize: 11,
      color: theme.colors.text,
      marginBottom: theme.spacing.paragraph,
      lineHeight: 1.6,
    },
    strong: {
      fontWeight: "bold",
    },
    em: {
      fontStyle: "italic",
    },
    link: {
      color: theme.colors.link,
      textDecoration: "underline",
    },
    list: {
      marginBottom: theme.spacing.paragraph,
      marginLeft: 15,
    },
    listItem: {
      flexDirection: "row",
      marginBottom: 4,
    },
    bullet: {
      width: 15,
      fontSize: 11,
      color: theme.colors.text,
    },
    listItemContent: {
      flex: 1,
      fontSize: 11,
      color: theme.colors.text,
      lineHeight: 1.5,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      paddingLeft: 12,
      marginVertical: 10,
      marginLeft: 10,
    },
    blockquoteText: {
      fontSize: 11,
      color: theme.colors.text,
      fontStyle: "italic",
      opacity: 0.8,
    },
    hr: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginVertical: 20,
    },
    image: {
      maxWidth: "100%",
      marginVertical: 10,
    },
  });

  const renderInlineTokens = (tokens: Tokens.Generic[]): React.ReactNode[] => {
    return tokens.map((token, index) => {
      switch (token.type) {
        case "text": {
          const text = (token as Tokens.Text).text;
          if (!text || text.trim() === '') return null;
          return <Text key={index}>{text}</Text>;
        }
        case "strong":
          return (
            <Text key={index} style={styles.strong}>
              {renderInlineTokens((token as Tokens.Strong).tokens)}
            </Text>
          );
        case "em":
          return (
            <Text key={index} style={styles.em}>
              {renderInlineTokens((token as Tokens.Em).tokens)}
            </Text>
          );
        case "codespan":
          return (
            <CodeBlock
              key={index}
              code={(token as Tokens.Codespan).text}
              theme={theme}
              inline
            />
          );
        case "link":
          const linkToken = token as Tokens.Link;
          return (
            <Link key={index} src={linkToken.href} style={styles.link}>
              {linkToken.text}
            </Link>
          );
        default:
          if ("text" in token) {
            const text = (token as { text: string }).text;
            if (!text || text.trim() === '') return null;
            return <Text key={index}>{text}</Text>;
          }
          return null;
      }
    }).filter(Boolean);
  };

  const renderToken = (token: Token, index: number): React.ReactNode => {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const content = heading.tokens 
          ? renderInlineTokens(heading.tokens as Tokens.Generic[]) 
          : heading.text;
        if (!content || (Array.isArray(content) && content.length === 0)) return null;
        const style =
          heading.depth === 1
            ? styles.h1
            : heading.depth === 2
              ? styles.h2
              : heading.depth === 3
                ? styles.h3
                : styles.h4;
        return (
          <Text key={index} style={style}>
            {content}
          </Text>
        );
      }

      case "paragraph": {
        const para = token as Tokens.Paragraph;
        const content = para.tokens 
          ? renderInlineTokens(para.tokens as Tokens.Generic[]) 
          : para.text;
        if (!content || (Array.isArray(content) && content.length === 0)) return null;
        return (
          <Text key={index} style={styles.paragraph}>
            {content}
          </Text>
        );
      }

      case "code": {
        const code = token as Tokens.Code;
        return (
          <CodeBlock
            key={index}
            code={code.text}
            language={code.lang}
            theme={theme}
          />
        );
      }

      case "list": {
        const list = token as Tokens.List;
        return (
          <View key={index} style={styles.list}>
            {list.items.map((item, i) => {
              const itemContent = item.tokens
                ? renderInlineTokens(item.tokens as Tokens.Generic[])
                : item.text;
              const hasContent = itemContent && (
                typeof itemContent === 'string' 
                  ? itemContent.trim() !== '' 
                  : Array.isArray(itemContent) && itemContent.length > 0
              );
              if (!hasContent) return null;
              return (
                <View key={i} style={styles.listItem}>
                  <Text style={styles.bullet}>{list.ordered ? `${i + 1}.` : "•"}</Text>
                  <Text style={styles.listItemContent}>
                    {itemContent}
                  </Text>
                </View>
              );
            }).filter(Boolean)}
          </View>
        );
      }

      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        if (!quote.text || quote.text.trim() === '') return null;
        return (
          <View key={index} style={styles.blockquote}>
            <Text style={styles.blockquoteText}>{quote.text}</Text>
          </View>
        );
      }

      case "table": {
        const table = token as Tokens.Table;
        const headers = table.header.map((h) => h.text);
        const rows = table.rows.map((row) => row.map((cell) => cell.text));
        return <Table key={index} headers={headers} rows={rows} theme={theme} />;
      }

      case "hr":
        return <View key={index} style={styles.hr} />;

      case "image": {
        const img = token as Tokens.Image;
        return <Image key={index} src={img.href} style={styles.image} />;
      }

      case "space":
        return null;

      default:
        if ("text" in token && typeof (token as Record<string, unknown>).text === "string") {
          return (
            <Text key={index} style={styles.paragraph}>
              {(token as Record<string, string>).text}
            </Text>
          );
        }
        return null;
    }
  };

  return <View>{tokens.map(renderToken).filter(Boolean)}</View>;
}

export default Markdown;
