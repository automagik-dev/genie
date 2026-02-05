import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface ResearchData {
  title: string;
  authors?: string[];
  institution?: string;
  date?: string;
  abstract?: string;
  keywords?: string[];
  sections?: Array<{
    title: string;
    content: string;
  }>;
  references?: string[];
}

interface ResearchProps {
  data: ResearchData;
  theme: ThemeConfig;
}

export function ResearchTemplate({ data, theme }: ResearchProps) {
  const styles = StyleSheet.create({
    page: {
      padding: theme.spacing.page,
      fontFamily: theme.fonts.body,
      fontSize: 10,
      color: theme.colors.text,
    },
    header: {
      marginBottom: 30,
      textAlign: "center",
    },
    title: {
      fontFamily: theme.fonts.heading,
      fontSize: 20,
      color: theme.colors.heading,
      marginBottom: 15,
      textAlign: "center",
      lineHeight: 1.3,
    },
    authors: {
      fontSize: 11,
      marginBottom: 5,
      textAlign: "center",
    },
    institution: {
      fontSize: 10,
      color: theme.colors.text,
      opacity: 0.7,
      fontStyle: "italic",
      textAlign: "center",
    },
    date: {
      fontSize: 10,
      color: theme.colors.text,
      opacity: 0.6,
      marginTop: 10,
      textAlign: "center",
    },
    abstractBox: {
      marginVertical: 20,
      paddingHorizontal: 30,
    },
    abstractTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 11,
      marginBottom: 8,
      textAlign: "center",
    },
    abstractText: {
      fontSize: 10,
      lineHeight: 1.6,
      textAlign: "justify",
    },
    keywords: {
      marginTop: 10,
      fontSize: 9,
    },
    keywordLabel: {
      fontFamily: theme.fonts.heading,
    },
    divider: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginVertical: 20,
    },
    sectionTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      color: theme.colors.heading,
      marginTop: 15,
      marginBottom: 8,
    },
    paragraph: {
      fontSize: 10,
      lineHeight: 1.7,
      marginBottom: 10,
      textAlign: "justify",
    },
    referencesTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      color: theme.colors.heading,
      marginTop: 25,
      marginBottom: 10,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 15,
    },
    reference: {
      fontSize: 9,
      marginBottom: 6,
      paddingLeft: 20,
      textIndent: -20,
      lineHeight: 1.4,
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
    <Document title={data.title} author={data.authors?.join(", ")}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{data.title}</Text>
          {data.authors && data.authors.length > 0 && (
            <Text style={styles.authors}>{data.authors.join(", ")}</Text>
          )}
          {data.institution && (
            <Text style={styles.institution}>{data.institution}</Text>
          )}
          {data.date && <Text style={styles.date}>{data.date}</Text>}
        </View>

        {/* Abstract */}
        {data.abstract && (
          <View style={styles.abstractBox}>
            <Text style={styles.abstractTitle}>Abstract</Text>
            <Text style={styles.abstractText}>{data.abstract}</Text>
            {data.keywords && data.keywords.length > 0 && (
              <Text style={styles.keywords}>
                <Text style={styles.keywordLabel}>Keywords: </Text>
                {data.keywords.join(", ")}
              </Text>
            )}
          </View>
        )}

        <View style={styles.divider} />

        {/* Sections */}
        {data.sections?.map((section, index) => (
          <View key={index}>
            <Text style={styles.sectionTitle}>
              {index + 1}. {section.title}
            </Text>
            <Text style={styles.paragraph}>{section.content}</Text>
          </View>
        ))}

        {/* References */}
        {data.references && data.references.length > 0 && (
          <View>
            <Text style={styles.referencesTitle}>References</Text>
            {data.references.map((ref, index) => (
              <Text key={index} style={styles.reference}>
                [{index + 1}] {ref}
              </Text>
            ))}
          </View>
        )}

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

export default ResearchTemplate;
