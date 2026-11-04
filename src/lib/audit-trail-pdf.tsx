import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT } from "./pdf-fonts";

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, fontFamily: PDF_FONT, color: "#14181A" },
  title: { fontSize: 18, marginBottom: 4, fontFamily: PDF_FONT, fontWeight: 700 },
  subtitle: { fontSize: 10, color: "#5B6461", marginBottom: 2 },
  generatedAt: { fontSize: 9, color: "#9AA19C", marginBottom: 22 },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 12, fontFamily: PDF_FONT, fontWeight: 700, marginBottom: 8, borderBottom: "1 solid #E4E7E5", paddingBottom: 4 },
  row: { flexDirection: "row", marginBottom: 6, paddingBottom: 6, borderBottom: "0.5 solid #F0F2F1" },
  rowWhen: { width: 118, color: "#5B6461", fontSize: 9 },
  rowMain: { flex: 1 },
  rowLabel: { fontFamily: PDF_FONT, fontWeight: 700, fontSize: 10 },
  rowDetail: { fontSize: 9, color: "#5B6461", marginTop: 1 },
  empty: { fontSize: 9.5, color: "#9AA19C", fontStyle: "italic" },
  footer: { position: "absolute", bottom: 32, left: 48, right: 48, fontSize: 8.5, color: "#9AA19C", textAlign: "center" },
});

// A compliance record gets read later, by people anywhere: every time is
// written in UTC and labeled as such, not in whatever zone the server
// happens to run in.
export function formatAuditTime(date: Date | null | undefined): string {
  if (!date) return "-";
  const day = date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day}, ${time} UTC`;
}

export type AuditEvent = { when: Date; label: string; detail?: string | null };

export function AuditTrailPdfDocument({
  clientName,
  templateName,
  workspaceName,
  generatedAt,
  events,
}: {
  clientName: string;
  templateName: string;
  workspaceName: string;
  generatedAt: Date;
  events: AuditEvent[];
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Audit trail</Text>
        <Text style={styles.subtitle}>{templateName} - {workspaceName} and {clientName}</Text>
        <Text style={styles.generatedAt}>Generated {formatAuditTime(generatedAt)}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Complete event history, in order</Text>
          {events.length === 0 ? (
            <Text style={styles.empty}>No events recorded yet.</Text>
          ) : (
            events.map((e, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rowWhen}>{formatAuditTime(e.when)}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.rowLabel}>{e.label}</Text>
                  {e.detail && <Text style={styles.rowDetail}>{e.detail}</Text>}
                </View>
              </View>
            ))
          )}
        </View>

        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
