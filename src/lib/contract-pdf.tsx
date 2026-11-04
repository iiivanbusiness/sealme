import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { Clause } from "./contract";
import { PDF_FONT } from "./pdf-fonts";

const styles = StyleSheet.create({
  page: { padding: 56, fontSize: 11, fontFamily: PDF_FONT, color: "#14181A" },
  logo: { height: 28, marginBottom: 18, objectFit: "contain" },
  title: { fontSize: 20, marginBottom: 6, fontFamily: PDF_FONT, fontWeight: 700 },
  parties: { fontSize: 11, color: "#5B6461", marginBottom: 26 },
  clause: { marginBottom: 16 },
  clauseTitle: { fontSize: 12, fontFamily: PDF_FONT, fontWeight: 700, marginBottom: 4 },
  clauseBody: { fontSize: 11, lineHeight: 1.5, color: "#3A403D" },
  signatureImage: { width: 160, height: 50, marginTop: 6, marginBottom: 4 },
  signatureEntry: { marginBottom: 10 },
  footer: { position: "absolute", bottom: 40, left: 56, right: 56, fontSize: 9, color: "#9AA19C", textAlign: "center" },
  docusignBlock: { marginTop: 10, marginBottom: 8 },
  docusignLine: { fontSize: 10, color: "#5B6461", marginBottom: 14 },
  docusignAnchor: { fontSize: 6, color: "#F2F5F2" }, // near-invisible against a white page — DocuSign's anchor-string matching just needs the text to exist in the PDF's text layer, not to be legible
});

// A signed date in a document anyone may read later, anywhere: written in
// UTC and labeled as such, not in whatever zone the server happens to run.
export function formatSignedAt(date: Date): string {
  const day = date.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day} at ${time} UTC`;
}

// A header value can't carry characters above U+00FF (a client named
// "Petrović" made the download throw), so the plain filename is an ASCII
// fallback and browsers read the real name from the UTF-8 filename*.
export function attachmentDisposition(filename: string): string {
  const ascii = filename.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "") || "download.pdf";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export type PdfCountersigner = { name: string; role: string; signedAt: Date; signatureImage?: string | null };

export function ContractPdfDocument({
  templateName,
  agencyName,
  agencyLogo,
  clientName,
  clauses,
  signedBy,
  signedAt,
  signatureImage,
  countersigners,
  docusignAnchors,
}: {
  templateName: string;
  agencyName: string;
  agencyLogo?: string | null;
  clientName: string;
  clauses: Clause[];
  signedBy?: string | null;
  signedAt?: Date | null;
  signatureImage?: string | null;
  // Everyone after the client who has signed so far, in signing order.
  countersigners?: PdfCountersigner[];
  // One entry per DocuSign recipient — each anchor string gets placed in
  // the PDF's text layer so DocuSign's anchor-tab matching can find it and
  // drop a signature field right there, without SealMe ever computing an
  // absolute x/y position on the page itself.
  docusignAnchors?: { label: string; anchor: string }[];
}) {
  const signatures = [
    ...(signedBy && signedAt ? [{ name: signedBy, signedAt, image: signatureImage }] : []),
    ...(countersigners ?? []).map((s) => ({ name: `${s.name} (${s.role})`, signedAt: s.signedAt, image: s.signatureImage })),
  ];

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {agencyLogo && <Image style={styles.logo} src={agencyLogo} />}
        <Text style={styles.title}>{templateName}</Text>
        <Text style={styles.parties}>Between {agencyName} and {clientName}</Text>
        {clauses.map((clause, i) => (
          <View key={clause.title} style={styles.clause}>
            <Text style={styles.clauseTitle}>{i + 1}. {clause.title}</Text>
            <Text style={styles.clauseBody}>{clause.body}</Text>
          </View>
        ))}
        {signatures.length > 0 && (
          <View style={styles.clause}>
            <Text style={styles.clauseTitle}>{signatures.length === 1 ? "Signature" : "Signatures"}</Text>
            {signatures.map((s, i) => (
              <View key={i} style={styles.signatureEntry} wrap={false}>
                {s.image && <Image style={styles.signatureImage} src={s.image} />}
                <Text style={styles.clauseBody}>Signed electronically by {s.name} on {formatSignedAt(s.signedAt)}.</Text>
              </View>
            ))}
          </View>
        )}
        {docusignAnchors && docusignAnchors.length > 0 && (
          <View style={styles.docusignBlock}>
            <Text style={styles.clauseTitle}>Signatures</Text>
            {docusignAnchors.map((a) => (
              <Text key={a.anchor} style={styles.docusignLine}>{a.label}: <Text style={styles.docusignAnchor}>{a.anchor}</Text></Text>
            ))}
          </View>
        )}
        <Text style={styles.footer} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} fixed />
      </Page>
    </Document>
  );
}
