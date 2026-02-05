import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import type { ThemeConfig } from "../themes/index.js";

interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface InvoiceData {
  invoiceNumber: string;
  date: string;
  dueDate?: string;
  from: {
    name: string;
    address?: string;
    email?: string;
  };
  to: {
    name: string;
    address?: string;
    email?: string;
  };
  items: InvoiceItem[];
  notes?: string;
  currency?: string;
}

interface InvoiceProps {
  data: InvoiceData;
  theme: ThemeConfig;
}

export function InvoiceTemplate({ data, theme }: InvoiceProps) {
  const currency = data.currency || "R$";

  const subtotal = data.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );

  const styles = StyleSheet.create({
    page: {
      padding: theme.spacing.page,
      fontFamily: theme.fonts.body,
      fontSize: 10,
      color: theme.colors.text,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 40,
    },
    title: {
      fontFamily: theme.fonts.heading,
      fontSize: 28,
      color: theme.colors.heading,
    },
    invoiceInfo: {
      textAlign: "right",
    },
    invoiceNumber: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      marginBottom: 4,
    },
    parties: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 30,
    },
    party: {
      width: "45%",
    },
    partyLabel: {
      fontFamily: theme.fonts.heading,
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.6,
      marginBottom: 5,
      textTransform: "uppercase",
    },
    partyName: {
      fontFamily: theme.fonts.heading,
      fontSize: 12,
      marginBottom: 4,
    },
    partyDetail: {
      fontSize: 10,
      color: theme.colors.text,
      opacity: 0.8,
      marginBottom: 2,
    },
    table: {
      marginVertical: 20,
    },
    tableHeader: {
      flexDirection: "row",
      borderBottomWidth: 2,
      borderBottomColor: theme.colors.heading,
      paddingBottom: 8,
      marginBottom: 8,
    },
    tableRow: {
      flexDirection: "row",
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    colDescription: { flex: 3 },
    colQty: { flex: 1, textAlign: "center" },
    colPrice: { flex: 1, textAlign: "right" },
    colTotal: { flex: 1, textAlign: "right" },
    headerText: {
      fontFamily: theme.fonts.heading,
      fontSize: 9,
      textTransform: "uppercase",
      color: theme.colors.text,
      opacity: 0.7,
    },
    totals: {
      marginTop: 20,
      alignItems: "flex-end",
    },
    totalRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      marginVertical: 4,
    },
    totalLabel: {
      width: 100,
      textAlign: "right",
      marginRight: 20,
      fontFamily: theme.fonts.heading,
    },
    totalValue: {
      width: 80,
      textAlign: "right",
    },
    grandTotal: {
      fontSize: 14,
      fontFamily: theme.fonts.heading,
      color: theme.colors.heading,
      borderTopWidth: 2,
      borderTopColor: theme.colors.heading,
      paddingTop: 8,
      marginTop: 8,
    },
    notes: {
      marginTop: 40,
      padding: 15,
      backgroundColor: theme.colors.codeBg,
      borderRadius: 4,
    },
    notesTitle: {
      fontFamily: theme.fonts.heading,
      fontSize: 10,
      marginBottom: 5,
    },
    notesText: {
      fontSize: 9,
      color: theme.colors.text,
      opacity: 0.8,
    },
  });

  return (
    <Document title={`Invoice ${data.invoiceNumber}`}>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>INVOICE</Text>
          <View style={styles.invoiceInfo}>
            <Text style={styles.invoiceNumber}>#{data.invoiceNumber}</Text>
            <Text>Date: {data.date}</Text>
            {data.dueDate && <Text>Due: {data.dueDate}</Text>}
          </View>
        </View>

        {/* From/To */}
        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>From</Text>
            <Text style={styles.partyName}>{data.from.name}</Text>
            {data.from.address && (
              <Text style={styles.partyDetail}>{data.from.address}</Text>
            )}
            {data.from.email && (
              <Text style={styles.partyDetail}>{data.from.email}</Text>
            )}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Bill To</Text>
            <Text style={styles.partyName}>{data.to.name}</Text>
            {data.to.address && (
              <Text style={styles.partyDetail}>{data.to.address}</Text>
            )}
            {data.to.email && (
              <Text style={styles.partyDetail}>{data.to.email}</Text>
            )}
          </View>
        </View>

        {/* Items Table */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.headerText, styles.colDescription]}>
              Description
            </Text>
            <Text style={[styles.headerText, styles.colQty]}>Qty</Text>
            <Text style={[styles.headerText, styles.colPrice]}>Unit Price</Text>
            <Text style={[styles.headerText, styles.colTotal]}>Total</Text>
          </View>
          {data.items.map((item, index) => (
            <View key={index} style={styles.tableRow}>
              <Text style={styles.colDescription}>{item.description}</Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colPrice}>
                {currency} {item.unitPrice.toFixed(2)}
              </Text>
              <Text style={styles.colTotal}>
                {currency} {(item.quantity * item.unitPrice).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totals}>
          <View style={[styles.totalRow, styles.grandTotal]}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>
              {currency} {subtotal.toFixed(2)}
            </Text>
          </View>
        </View>

        {/* Notes */}
        {data.notes && (
          <View style={styles.notes}>
            <Text style={styles.notesTitle}>Notes</Text>
            <Text style={styles.notesText}>{data.notes}</Text>
          </View>
        )}
      </Page>
    </Document>
  );
}

export default InvoiceTemplate;
