import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface ReportData {
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  summary?: string;
  sections?: Array<{
    title: string;
    content: string;
  }>;
}

interface ReportProps {
  data: ReportData;
  theme: ThemeConfig;
}

export function ReportTemplate({ data, theme }: ReportProps) {
  const styles = StyleSheet.create({
    page: {
      padding: theme.spacing.page,
      fontFamily: theme.fonts.body,
      fontSize: 11,
      color: theme.colors.text,
    },
    titlePage: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    title: {
      fontFamily: theme.fonts.heading,
      fontSize: 32,
      color: theme.colors.heading,
      marginBottom: 10,
      textAlign: "center",
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.text,
      opacity: 0.7,
      marginBottom: 30,
      textAlign: "center",
    },
    meta: {
      fontSize: 12,
      color: theme.colors.text,
      opacity: 0.6,
      textAlign: "center",
    },
    sectionTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 18,
      color: theme.colors.heading,
      marginTop: 20,
      marginBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: 5,
    },
    paragraph: {
      fontSize: 11,
      lineHeight: 1.6,
      marginBottom: theme.spacing.paragraph,
    },
    summary: {
      backgroundColor: theme.colors.codeBg,
      padding: 15,
      borderRadius: 5,
      marginVertical: 15,
    },
    summaryTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      color: theme.colors.heading,
      marginBottom: 8,
    },
    footer: {
      position: "absolute",
      bottom: 20,
      left: theme.spacing.page,
      right: theme.spacing.page,
      textAlign: "center",
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.6,
    },
  });

  return (
    <Document title={data.title} author={data.author}>
      {/* Title Page */}
      <Page size="A4" style={styles.page}>
        <View style={styles.titlePage}>
          <Text style={styles.title}>{data.title}</Text>
          {data.subtitle && <Text style={styles.subtitle}>{data.subtitle}</Text>}
          {data.author && <Text style={styles.meta}>{data.author}</Text>}
          {data.date && <Text style={styles.meta}>{data.date}</Text>}
        </View>
      </Page>

      {/* Content Pages */}
      <Page size="A4" style={styles.page}>
        {data.summary && (
          <View style={styles.summary}>
            <Text style={styles.summaryTitle}>Executive Summary</Text>
            <Text style={styles.paragraph}>{data.summary}</Text>
          </View>
        )}

        {data.sections?.map((section, index) => (
          <View key={index}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.paragraph}>{section.content}</Text>
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

export default ReportTemplate;
