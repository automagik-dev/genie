import React from "react";
import {
  Document as PDFDocument,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface DocumentProps {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  theme: ThemeConfig;
  children: React.ReactNode;
  showPageNumbers?: boolean;
}

export function Document({
  title,
  subtitle,
  author,
  date,
  theme,
  children,
  showPageNumbers = true,
}: DocumentProps) {
  const isGlass = theme.name === "glass";
  const isExecutive = theme.name === "executive";
  const isDark = theme.name === "dark";

  const styles = StyleSheet.create({
    page: {
      padding: theme.spacing.page,
      paddingTop: title ? 60 : theme.spacing.page,
      fontFamily: theme.fonts.body,
      fontSize: 11,
      color: theme.colors.text,
      backgroundColor: theme.colors.background || "#ffffff",
    },
    // Title page / header section
    titleSection: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: title ? 120 : 0,
      paddingTop: 30,
      paddingHorizontal: theme.spacing.page,
      paddingBottom: 20,
      ...(isGlass && {
        backgroundColor: "rgba(99, 102, 241, 0.08)",
        borderBottomWidth: 1,
        borderBottomColor: "rgba(99, 102, 241, 0.2)",
      }),
      ...(isExecutive && {
        backgroundColor: "#1a365d",
        borderBottomWidth: 3,
        borderBottomColor: "#c53030",
      }),
      ...(isDark && {
        backgroundColor: "#1f2937",
        borderBottomWidth: 2,
        borderBottomColor: "#6366f1",
      }),
      ...(!isGlass && !isExecutive && !isDark && {
        borderBottomWidth: 2,
        borderBottomColor: theme.colors.border,
      }),
    },
    titleText: {
      fontFamily: theme.fonts.heading,
      fontSize: 22,
      color: isGlass 
        ? "#4338ca" 
        : isExecutive || isDark 
          ? "#ffffff" 
          : theme.colors.heading,
      marginBottom: 4,
    },
    subtitleText: {
      fontFamily: theme.fonts.body,
      fontSize: 12,
      color: isGlass 
        ? "#6366f1" 
        : isExecutive || isDark 
          ? "rgba(255, 255, 255, 0.8)" 
          : theme.colors.text,
      opacity: 0.9,
      marginBottom: 8,
    },
    metaRow: {
      flexDirection: "row",
      marginTop: 6,
    },
    metaText: {
      fontSize: 9,
      color: isGlass 
        ? "#64748b" 
        : isExecutive || isDark 
          ? "rgba(255, 255, 255, 0.6)" 
          : theme.colors.text,
      opacity: 0.7,
      marginRight: 20,
    },
    // Running header for subsequent pages
    header: {
      position: "absolute",
      top: 15,
      left: theme.spacing.page,
      right: theme.spacing.page,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingBottom: 8,
      borderBottomWidth: isGlass ? 1 : 0,
      borderBottomColor: "rgba(99, 102, 241, 0.15)",
    },
    headerTitle: {
      fontSize: 9,
      color: isGlass ? "#6366f1" : theme.colors.text,
      opacity: 0.7,
      fontFamily: theme.fonts.heading,
    },
    headerDate: {
      fontSize: 8,
      color: theme.colors.text,
      opacity: 0.5,
    },
    // Footer
    footer: {
      position: "absolute",
      bottom: 20,
      left: theme.spacing.page,
      right: theme.spacing.page,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    footerLeft: {
      fontSize: 8,
      color: theme.colors.text,
      opacity: 0.4,
    },
    footerCenter: {
      fontSize: 9,
      color: isGlass ? "#6366f1" : theme.colors.text,
      opacity: 0.6,
      fontFamily: theme.fonts.heading,
    },
    footerRight: {
      fontSize: 8,
      color: theme.colors.text,
      opacity: 0.4,
    },
    // Content
    content: {
      flex: 1,
      marginTop: title ? 80 : 0,
    },
    // Glass decorative elements
    glassAccent: {
      position: "absolute",
      top: 0,
      right: 0,
      width: 150,
      height: 150,
      backgroundColor: "rgba(139, 92, 246, 0.05)",
      borderRadius: 75,
    },
  });

  return (
    <PDFDocument
      title={title}
      author={author}
      creator="genie-pdf"
      producer="genie-pdf by Namastex Labs"
    >
      <Page size="A4" style={styles.page}>
        {/* Title Section - First page only */}
        {title && (
          <View style={styles.titleSection} fixed={false}>
            <Text style={styles.titleText}>{title}</Text>
            {subtitle && <Text style={styles.subtitleText}>{subtitle}</Text>}
            <View style={styles.metaRow}>
              {author && <Text style={styles.metaText}>{author}</Text>}
              {date && <Text style={styles.metaText}>{date}</Text>}
            </View>
          </View>
        )}

        {/* Running header for pages after first */}
        <View style={styles.header} fixed>
          <Text 
            style={styles.headerTitle}
            render={({ pageNumber }) => pageNumber > 1 ? (title || '') : ''}
          />
          <Text 
            style={styles.headerDate}
            render={({ pageNumber }) => pageNumber > 1 ? (date || '') : ''}
          />
        </View>

        {/* Main content */}
        <View style={styles.content}>{children}</View>

        {/* Footer */}
        {showPageNumbers && (
          <View style={styles.footer} fixed>
            <Text style={styles.footerLeft}>{author || "genie-pdf"}</Text>
            <Text
              style={styles.footerCenter}
              render={({ pageNumber, totalPages }) =>
                `— ${pageNumber} —`
              }
            />
            <Text style={styles.footerRight}>{title ? title.slice(0, 30) : ""}</Text>
          </View>
        )}
      </Page>
    </PDFDocument>
  );
}

export default Document;
