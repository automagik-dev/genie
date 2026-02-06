import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface TableProps {
  headers: string[];
  rows: string[][];
  theme: ThemeConfig;
}

export function Table({ headers, rows, theme }: TableProps) {
  const isGlass = theme.name === "glass";
  const isExecutive = theme.name === "executive";
  const isDark = theme.name === "dark";
  
  const styles = StyleSheet.create({
    tableContainer: {
      marginVertical: 12,
      borderRadius: isGlass ? 8 : 4,
      overflow: "hidden",
      ...(isGlass && {
        backgroundColor: "rgba(255, 255, 255, 0.6)",
        borderWidth: 1,
        borderColor: "rgba(148, 163, 184, 0.3)",
      }),
    },
    table: {
      width: "100%",
    },
    headerRow: {
      flexDirection: "row",
      backgroundColor: isGlass 
        ? "rgba(99, 102, 241, 0.15)" 
        : isDark 
          ? "#374151"
          : isExecutive 
            ? "#1a365d" 
            : theme.colors.codeBg,
      borderBottomWidth: 2,
      borderBottomColor: isGlass 
        ? "rgba(99, 102, 241, 0.3)" 
        : theme.colors.border,
      minHeight: 32,
      alignItems: "center",
    },
    row: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: isGlass 
        ? "rgba(148, 163, 184, 0.2)" 
        : theme.colors.border,
      minHeight: 28,
      alignItems: "center",
      backgroundColor: "transparent",
    },
    rowEven: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: isGlass 
        ? "rgba(148, 163, 184, 0.2)" 
        : theme.colors.border,
      minHeight: 28,
      alignItems: "center",
      backgroundColor: isGlass 
        ? "rgba(241, 245, 249, 0.5)" 
        : isDark 
          ? "#1f2937"
          : "rgba(0, 0, 0, 0.02)",
    },
    lastRow: {
      flexDirection: "row",
      minHeight: 28,
      alignItems: "center",
    },
    headerCell: {
      flex: 1,
      paddingVertical: 8,
      paddingHorizontal: 10,
      fontFamily: theme.fonts.heading,
      fontSize: 9,
      color: isGlass 
        ? "#4338ca" 
        : isExecutive || isDark 
          ? "#ffffff" 
          : theme.colors.heading,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    cell: {
      flex: 1,
      paddingVertical: 6,
      paddingHorizontal: 10,
      fontSize: 9,
      color: theme.colors.text,
      lineHeight: 1.4,
    },
    // Special styling for status indicators
    statusCell: {
      flex: 1,
      paddingVertical: 6,
      paddingHorizontal: 10,
      fontSize: 9,
      color: theme.colors.text,
    },
  });

  // Detect if cell contains status indicators
  const formatCell = (cell: string, isHeader: boolean = false) => {
    if (!cell) return ' ';
    
    // Convert emoji/symbol indicators to styled versions
    let formatted = cell
      .replace(/✓/g, '✓')
      .replace(/✗/g, '✗')
      .replace(/★/g, '★')
      .replace(/●/g, '●');
    
    return formatted || ' ';
  };

  return (
    <View style={styles.tableContainer}>
      <View style={styles.table}>
        {/* Header Row */}
        <View style={styles.headerRow}>
          {headers.map((header, i) => (
            <Text key={i} style={styles.headerCell}>
              {formatCell(header, true)}
            </Text>
          ))}
        </View>
        
        {/* Data Rows */}
        {rows.map((row, rowIndex) => {
          const isLast = rowIndex === rows.length - 1;
          const isEven = rowIndex % 2 === 1;
          const rowStyle = isLast 
            ? styles.lastRow 
            : isEven 
              ? styles.rowEven 
              : styles.row;
          
          return (
            <View key={rowIndex} style={rowStyle}>
              {row.map((cell, cellIndex) => (
                <Text key={cellIndex} style={styles.cell}>
                  {formatCell(cell)}
                </Text>
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default Table;
