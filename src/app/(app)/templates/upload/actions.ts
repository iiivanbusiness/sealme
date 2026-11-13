"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { extractText, splitIntoClauses } from "@/lib/parse-document";
import { requirePermission } from "@/lib/permissions";
import { isExtractionConfigured } from "@/lib/extract-deal";
import { detectFields, placeFields, type DetectedContract, type ReviewClause } from "@/lib/detect-fields";
import { reportError } from "@/lib/error-report";
import { findSignatureBlocks, markSignatureBlocks } from "@/lib/signature-block";

// name: a suggested template name the user can change on the review screen.
// summary: one sentence on what the contract covers, for the description.
// dropped: places the model pointed at that couldn't be marked in the text,
// so the review screen can say to check for them. The fields themselves are
// read off the clauses, as the user changes them.
export type ContractReview = {
  name: string;
  summary: string | null;
  fileName: string;
  clauses: ReviewClause[];
  autoFound: boolean;
  dropped: number;
};
export type AnalyzeResult = { ok: true; review: ContractReview } | { ok: false; error: string };
export type SaveResult = { error: string } | null;

// Keep in step with serverActions.bodySizeLimit in next.config.ts, which
// has a little room on top for the form's own overhead.
const MAX_BYTES = 4 * 1024 * 1024;

// Step 1 of uploading a contract: read the file, split it into clauses and
// have the model find the parts that change per client. Nothing is saved
// yet. The user checks the fields first and saveUploadedTemplate stores
// what they confirmed. Errors come back as text for the form to show,
// since a thrown error reaches the browser without its message.
export async function analyzeUploadedContract(formData: FormData): Promise<AnalyzeResult> {
  await requirePermission("canManageTemplates");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  const isWord = /\.docx$/i.test(file.name);
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return { ok: false, error: "Upload a PDF, a Word file (.docx) or a .txt file." };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: isWord ? "This Word file is over 4 MB, usually because of images. Remove them, or upload it as a PDF." : "This file is over 4 MB. Upload the Word version, or export a smaller PDF." };
  }

  let text: string;
  try {
    text = await extractText(file);
  } catch (err) {
    void reportError(err, "templates.upload.read", { fileName: file.name });
    return { ok: false, error: isWord ? "We couldn't read this Word file. Open it in Word, save it again as .docx and upload that." : "We couldn't read this file. Try the Word version, or export the PDF again." };
  }
  // A scanned PDF has no text, only page markers like "-- 1 of 2 --".
  if (text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").replace(/\s+/g, "").length < 40) {
    return { ok: false, error: "We couldn't find any text in this file. If it's a scan, upload the Word version instead." };
  }

  const clauses = splitIntoClauses(text);
  let found: DetectedContract | null = null;
  if (isExtractionConfigured()) {
    try {
      found = await detectFields(clauses);
    } catch (err) {
      // The contract is still usable without fields: the review screen says
      // they weren't found and offers to add them by hand.
      void reportError(err, "templates.upload.detect", { fileName: file.name });
    }
  }
  const placed = found ?? placeFields(clauses, []);
  // The file's own signature block, which the review screen leaves out
  // unless the user keeps it: SealMe adds its own signature section.
  const marked = markSignatureBlocks(placed.clauses, findSignatureBlocks(clauses));

  return {
    ok: true,
    review: {
      name: found?.title || nameFromFile(file.name),
      summary: found?.summary ?? null,
      fileName: file.name.slice(0, 200),
      clauses: marked,
      autoFound: found !== null,
      dropped: placed.dropped,
    },
  };
}

// "Acme_Corp-MSA FINAL signed v3.pdf" becomes "Acme Corp MSA". Only used
// when the model didn't suggest a name; the user can change it either way.
function nameFromFile(fileName: string): string {
  const name = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+|\s-\s|-{2,}/g, " ")
    .replace(/\b(final|signed|executed|draft|copy|clean|redline|v\d+(?:\.\d+)*)\b/gi, " ")
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return name || "Uploaded contract";
}

// Step 2: store the template with the fields the user kept. The clauses
// come from the review screen; like any template edit they're the user's
// own wording, so they're only checked for shape. Problems come back as
// text so the review screen, and what the user removed on it, stays put.
export async function saveUploadedTemplate(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  const user = await requirePermission("canManageTemplates");

  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const fileName = String(formData.get("fileName") ?? "").trim().slice(0, 200) || "your file";
  const summary = String(formData.get("summary") ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  let clauses: { title: string; body: string; label?: string }[] = [];
  try {
    const raw: unknown = JSON.parse(String(formData.get("clausesJson") ?? "[]"));
    if (Array.isArray(raw)) {
      clauses = raw
        .filter((c): c is { title: string; body: string; label?: unknown } => typeof c?.title === "string" && typeof c?.body === "string")
        // label: the clause's own number in the file ("3", "2.03"), kept
        // so references in the text still match. Short by nature.
        .map((c) => (typeof c.label === "string" && c.label.length <= 12 ? { title: c.title, body: c.body, label: c.label.trim() } : { title: c.title, body: c.body }))
        .filter((c) => c.title.trim() || c.body.trim());
    }
  } catch {
    clauses = [];
  }
  if (!name) return { error: "The template needs a name. Upload the file again." };
  if (clauses.length === 0) return { error: "There's no contract text to save. Upload the file again." };

  const keys = new Set(clauses.flatMap((c) => [...c.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
  let id: string;
  try {
    const template = await prisma.contractTemplate.create({
      data: {
        workspaceId: user.workspaceId,
        name,
        // What the contract is for, like the built-in templates say: it's
        // what picks the template after a sales call.
        description: !keys.size
          ? `Imported from ${fileName}. Add {placeholder} fields where terms should be filled in automatically.`
          : summary || `Imported from ${fileName}. ${keys.size} ${keys.size === 1 ? "field fills" : "fields fill"} in from the call.`,
        requiredFieldCount: keys.size,
        clauses: JSON.stringify(clauses),
      },
    });
    id = template.id;
  } catch (err) {
    void reportError(err, "templates.upload.save", { fileName });
    return { error: "We couldn't save the template. Try again in a moment." };
  }

  redirect(keys.size ? `/templates/${id}` : `/templates/${id}/edit`);
}
