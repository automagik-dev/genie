import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";
import type { HeadingInfo } from "../markdown.js";

interface TOCProps {
  headings: HeadingInfo[];
  theme: ThemeConfig;
  title?: string;
}

export function TOC({ headings, theme, title = "Table of Contents" }: TOCProps) {
  const styles = StyleSheet.create({
    container: {
      marginBottom: 30,
      paddingBottom: 20,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    title: {
      fontFamily: theme.fonts.heading,
      fontSize: 18,
      color: theme.colors.heading,
      marginBottom: 15,
    },
    entry: {
      flexDirection: "row",
      marginBottom: 6,
    },
    entryText: {
      fontSize: 10,
      color: theme.colors.text,
    },
    level1: {
      marginLeft: 0,
    },
    level2: {
      marginLeft: 15,
    },
    level3: {
      marginLeft: 30,
    },
    level4: {
      marginLeft: 45,
    },
  });

  const getLevelStyle = (level: number) => {
    switch (level) {
      case 1:
        return styles.level1;
      case 2:
        return styles.level2;
      case 3:
        return styles.level3;
      default:
        return styles.level4;
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {headings.map((heading, index) => (
        <View key={index} style={[styles.entry, getLevelStyle(heading.level)]}>
          <Text style={styles.entryText}>
            {heading.level > 1 ? "• " : ""}
            {heading.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

export default TOC;
