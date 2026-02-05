import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface TableProps {
  headers: string[];
  rows: string[][];
  theme: ThemeConfig;
}

export function Table({ headers, rows, theme }: TableProps) {
  const styles = StyleSheet.create({
    table: {
      marginVertical: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    headerRow: {
      flexDirection: "row",
      backgroundColor: theme.colors.codeBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    row: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    lastRow: {
      flexDirection: "row",
    },
    headerCell: {
      flex: 1,
      padding: 6,
      fontFamily: theme.fonts.heading,
      fontSize: 9,
      color: theme.colors.heading,
    },
    cell: {
      flex: 1,
      padding: 6,
      fontSize: 9,
      color: theme.colors.text,
    },
  });

  return (
    <View style={styles.table}>
      <View style={styles.headerRow}>
        {headers.map((header, i) => (
          <Text key={i} style={styles.headerCell}>
            {header || ' '}
          </Text>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          style={rowIndex === rows.length - 1 ? styles.lastRow : styles.row}
        >
          {row.map((cell, cellIndex) => (
            <Text key={cellIndex} style={styles.cell}>
              {cell || ' '}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export default Table;
