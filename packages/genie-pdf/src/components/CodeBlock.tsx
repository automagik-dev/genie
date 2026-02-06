import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface CodeBlockProps {
  code: string;
  language?: string;
  theme: ThemeConfig;
  inline?: boolean;
}

export function CodeBlock({
  code,
  language,
  theme,
  inline = false,
}: CodeBlockProps) {
  const isGlass = theme.name === "glass";
  const isDark = theme.name === "dark";

  const styles = StyleSheet.create({
    codeBlock: {
      backgroundColor: isGlass 
        ? "rgba(241, 245, 249, 0.8)" 
        : isDark 
          ? "#1f2937" 
          : theme.colors.codeBg,
      borderRadius: isGlass ? 8 : 4,
      padding: 12,
      marginVertical: 10,
      borderLeftWidth: isGlass ? 4 : 3,
      borderLeftColor: isGlass 
        ? "rgba(99, 102, 241, 0.4)" 
        : theme.colors.border,
      ...(isGlass && {
        borderWidth: 1,
        borderColor: "rgba(148, 163, 184, 0.2)",
      }),
    },
    codeText: {
      fontFamily: theme.fonts.mono,
      fontSize: 8,
      color: isGlass ? "#475569" : theme.colors.code,
      lineHeight: 1.6,
    },
    inlineCode: {
      fontFamily: theme.fonts.mono,
      fontSize: 9,
      color: isGlass ? "#6366f1" : theme.colors.code,
      backgroundColor: isGlass 
        ? "rgba(99, 102, 241, 0.1)" 
        : theme.colors.codeBg,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 3,
    },
    languageTag: {
      fontSize: 7,
      color: isGlass ? "#6366f1" : theme.colors.text,
      opacity: isGlass ? 1 : 0.5,
      marginBottom: 8,
      fontFamily: theme.fonts.heading,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
  });

  if (inline) {
    return <Text style={styles.inlineCode}>{code || ' '}</Text>;
  }

  return (
    <View style={styles.codeBlock}>
      {language && language.trim() !== '' && (
        <Text style={styles.languageTag}>{language}</Text>
      )}
      <Text style={styles.codeText}>{code || ' '}</Text>
    </View>
  );
}

export default CodeBlock;
