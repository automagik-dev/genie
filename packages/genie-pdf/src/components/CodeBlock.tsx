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
  const styles = StyleSheet.create({
    codeBlock: {
      backgroundColor: theme.colors.codeBg,
      borderRadius: 4,
      padding: 12,
      marginVertical: 8,
      borderLeft: `3px solid ${theme.colors.border}`,
    },
    codeText: {
      fontFamily: theme.fonts.mono,
      fontSize: 9,
      color: theme.colors.code,
      lineHeight: 1.5,
    },
    inlineCode: {
      fontFamily: theme.fonts.mono,
      fontSize: 9,
      color: theme.colors.code,
      backgroundColor: theme.colors.codeBg,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 2,
    },
    languageTag: {
      fontSize: 8,
      color: theme.colors.text,
      opacity: 0.5,
      marginBottom: 6,
    },
  });

  if (inline) {
    return <Text style={styles.inlineCode}>{code || ' '}</Text>;
  }

  return (
    <View style={styles.codeBlock}>
      {language && language.trim() !== '' && <Text style={styles.languageTag}>{language}</Text>}
      <Text style={styles.codeText}>{code || ' '}</Text>
    </View>
  );
}

export default CodeBlock;
