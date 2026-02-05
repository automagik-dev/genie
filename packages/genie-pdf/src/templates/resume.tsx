import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  Link,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface Experience {
  title: string;
  company: string;
  location?: string;
  startDate: string;
  endDate?: string;
  description?: string;
  highlights?: string[];
}

interface Education {
  degree: string;
  institution: string;
  location?: string;
  date: string;
  details?: string;
}

interface ResumeData {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  location?: string;
  website?: string;
  linkedin?: string;
  github?: string;
  summary?: string;
  experience?: Experience[];
  education?: Education[];
  skills?: string[];
  languages?: Array<{ name: string; level: string }>;
}

interface ResumeProps {
  data: ResumeData;
  theme: ThemeConfig;
}

export function ResumeTemplate({ data, theme }: ResumeProps) {
  const styles = StyleSheet.create({
    page: {
      padding: 40,
      fontFamily: theme.fonts.body,
      fontSize: 10,
      color: theme.colors.text,
    },
    header: {
      marginBottom: 20,
      borderBottomWidth: 2,
      borderBottomColor: theme.colors.heading,
      paddingBottom: 15,
    },
    name: {
      fontFamily: theme.fonts.heading,
      fontSize: 24,
      color: theme.colors.heading,
      marginBottom: 4,
    },
    jobTitle: {
      fontSize: 12,
      color: theme.colors.text,
      opacity: 0.8,
      marginBottom: 10,
    },
    contactRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 15,
    },
    contactItem: {
      fontSize: 9,
      color: theme.colors.text,
    },
    link: {
      color: theme.colors.link,
    },
    section: {
      marginTop: 15,
    },
    sectionTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      color: theme.colors.heading,
      marginBottom: 10,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    summary: {
      fontSize: 10,
      lineHeight: 1.5,
      color: theme.colors.text,
    },
    experienceItem: {
      marginBottom: 12,
    },
    experienceHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 3,
    },
    experienceTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 11,
    },
    experienceDates: {
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.7,
    },
    experienceCompany: {
      fontSize: 10,
      color: theme.colors.text,
      opacity: 0.8,
      marginBottom: 4,
    },
    experienceDescription: {
      fontSize: 9,
      lineHeight: 1.5,
      marginBottom: 4,
    },
    highlight: {
      fontSize: 9,
      marginLeft: 10,
      marginBottom: 2,
      lineHeight: 1.4,
    },
    educationItem: {
      marginBottom: 10,
    },
    educationDegree: {
      fontFamily: theme.fonts.heading,
      fontSize: 11,
    },
    educationSchool: {
      fontSize: 10,
      color: theme.colors.text,
      opacity: 0.8,
    },
    educationDate: {
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.7,
    },
    skillsContainer: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    skill: {
      fontSize: 9,
      backgroundColor: theme.colors.codeBg,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 3,
    },
    languageItem: {
      flexDirection: "row",
      marginBottom: 4,
    },
    languageName: {
      fontSize: 10,
      width: 80,
    },
    languageLevel: {
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.7,
    },
  });

  return (
    <Document title={`${data.name} - Resume`} author={data.name}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.name}>{data.name}</Text>
          {data.title && <Text style={styles.jobTitle}>{data.title}</Text>}
          <View style={styles.contactRow}>
            {data.email && <Text style={styles.contactItem}>{data.email}</Text>}
            {data.phone && <Text style={styles.contactItem}>{data.phone}</Text>}
            {data.location && (
              <Text style={styles.contactItem}>{data.location}</Text>
            )}
            {data.website && (
              <Link src={data.website} style={[styles.contactItem, styles.link]}>
                {data.website.replace(/^https?:\/\//, "")}
              </Link>
            )}
            {data.linkedin && (
              <Link
                src={`https://linkedin.com/in/${data.linkedin}`}
                style={[styles.contactItem, styles.link]}
              >
                linkedin.com/in/{data.linkedin}
              </Link>
            )}
            {data.github && (
              <Link
                src={`https://github.com/${data.github}`}
                style={[styles.contactItem, styles.link]}
              >
                github.com/{data.github}
              </Link>
            )}
          </View>
        </View>

        {/* Summary */}
        {data.summary && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text style={styles.summary}>{data.summary}</Text>
          </View>
        )}

        {/* Experience */}
        {data.experience && data.experience.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Experience</Text>
            {data.experience.map((exp, index) => (
              <View key={index} style={styles.experienceItem}>
                <View style={styles.experienceHeader}>
                  <Text style={styles.experienceTitle}>{exp.title}</Text>
                  <Text style={styles.experienceDates}>
                    {exp.startDate} – {exp.endDate || "Present"}
                  </Text>
                </View>
                <Text style={styles.experienceCompany}>
                  {exp.company}
                  {exp.location ? ` · ${exp.location}` : ""}
                </Text>
                {exp.description && (
                  <Text style={styles.experienceDescription}>
                    {exp.description}
                  </Text>
                )}
                {exp.highlights?.map((highlight, i) => (
                  <Text key={i} style={styles.highlight}>
                    • {highlight}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}

        {/* Education */}
        {data.education && data.education.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Education</Text>
            {data.education.map((edu, index) => (
              <View key={index} style={styles.educationItem}>
                <Text style={styles.educationDegree}>{edu.degree}</Text>
                <Text style={styles.educationSchool}>
                  {edu.institution}
                  {edu.location ? ` · ${edu.location}` : ""}
                </Text>
                <Text style={styles.educationDate}>{edu.date}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Skills */}
        {data.skills && data.skills.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Skills</Text>
            <View style={styles.skillsContainer}>
              {data.skills.map((skill, index) => (
                <Text key={index} style={styles.skill}>
                  {skill}
                </Text>
              ))}
            </View>
          </View>
        )}

        {/* Languages */}
        {data.languages && data.languages.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Languages</Text>
            {data.languages.map((lang, index) => (
              <View key={index} style={styles.languageItem}>
                <Text style={styles.languageName}>{lang.name}</Text>
                <Text style={styles.languageLevel}>{lang.level}</Text>
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}

export default ResumeTemplate;
