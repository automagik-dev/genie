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
  author?: string;
  theme: ThemeConfig;
  children: React.ReactNode;
  showPageNumbers?: boolean;
}

export function Document({
  title,
  author,
  theme,
  children,
  showPageNumbers = true,
}: DocumentProps) {
  const styles = StyleSheet.create({
    page: {
      padding: theme.spacing.page,
      fontFamily: theme.fonts.body,
      fontSize: 11,
      color: theme.colors.text,
      backgroundColor: theme.colors.background || "#ffffff",
    },
    header: {
      position: "absolute",
      top: 15,
      left: theme.spacing.page,
      right: theme.spacing.page,
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.6,
    },
    footer: {
      position: "absolute",
      bottom: 20,
      left: theme.spacing.page,
      right: theme.spacing.page,
      flexDirection: "row",
      justifyContent: "center",
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.6,
    },
    content: {
      flex: 1,
    },
  });

  return (
    <PDFDocument
      title={title}
      author={author}
      creator="genie-pdf"
      producer="genie-pdf"
    >
      <Page size="A4" style={styles.page}>
        {(title || author) && (
          <View style={styles.header} fixed>
            <Text>{title || ""}</Text>
            <Text>{author || ""}</Text>
          </View>
        )}
        <View style={styles.content}>{children}</View>
        {showPageNumbers && (
          <View style={styles.footer} fixed>
            <Text
              render={({ pageNumber, totalPages }) =>
                `${pageNumber} / ${totalPages}`
              }
            />
          </View>
        )}
      </Page>
    </PDFDocument>
  );
}

export default Document;
