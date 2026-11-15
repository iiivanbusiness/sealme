"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission, currentUserWithRole } from "@/lib/permissions";
import { parseCsvWithHeader } from "@/lib/csv";
import { logAudit } from "@/lib/audit";
import { leadForClient } from "@/lib/client-lead";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";

const MAX_ROWS = 1000;
const VALID_STATUSES = new Set(["signed", "sent", "ready", "missing_info"]);

// The UTC day a date falls on, for matching a signed_date to a contract
// signed that day whatever the time.
function sameDay(d: Date): { gte: Date; lt: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export type ImportResult = {
  error?: string;
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
};

// One-shot: parse, validate, and create in the same call rather than a
// separate preview step: a failed row is reported with its line number
// so the admin can fix just those rows and re-upload the rest (already-
// imported rows are unaffected either way, since nothing here is
// transactional across rows).
//
// Expected columns (header row, any order): client_name, client_company,
// client_email, service, fee, status, signed_date. Only client_name (or
// client_company), service, and fee are required.
export async function importClientsAndDeals(formData: FormData): Promise<ImportResult> {
  const user = await requirePermission("canManageWorkspace");
  const currentUser = await currentUserWithRole();
  const text = String(formData.get("csv") ?? "");
  if (!text.trim()) return { error: "Paste or upload CSV data first", created: 0, skipped: 0, errors: [] };

  const rows = parseCsvWithHeader(text);
  if (rows.length === 0) return { error: "No data rows found. Check the header row is included", created: 0, skipped: 0, errors: [] };
  if (rows.length > MAX_ROWS) return { error: `Too many rows (${rows.length}). Split into batches of ${MAX_ROWS} or fewer`, created: 0, skipped: 0, errors: [] };

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +1 for 0-index, +1 for the header row
    const r = rows[i];
    const clientName = r.client_name || r.client_company;
    const clientCompany = r.client_company || r.client_name;
    // Emails are matched and kept in lowercase, the way the rest of SealMe
    // keeps them, so "Sam@Acme.com" in one export finds the same client.
    const clientEmail = r.client_email ? r.client_email.toLowerCase() : null;
    const service = r.service;
    const fee = r.fee;
    const rawStatus = (r.status || "").toLowerCase();
    const signedDateRaw = r.signed_date;

    if (!clientName) {
      result.errors.push({ row: rowNum, message: "Missing client_name/client_company" });
      result.skipped++;
      continue;
    }
    if (!service) {
      result.errors.push({ row: rowNum, message: "Missing service" });
      result.skipped++;
      continue;
    }
    if (!fee) {
      result.errors.push({ row: rowNum, message: "Missing fee" });
      result.skipped++;
      continue;
    }

    let signedDate: Date | null = null;
    if (signedDateRaw) {
      signedDate = new Date(signedDateRaw);
      if (Number.isNaN(signedDate.getTime())) {
        result.errors.push({ row: rowNum, message: `Invalid signed_date "${signedDateRaw}". Use YYYY-MM-DD` });
        result.skipped++;
        continue;
      }
    }

    const status = VALID_STATUSES.has(rawStatus) ? rawStatus : signedDate ? "signed" : "ready";

    try {
      // Match an existing client by email first (the more reliable key),
      // falling back to an exact name+company match, otherwise create a
      // new one. This keeps a re-run of the same file (or a file that
      // covers several deals per client) from spawning duplicate clients.
      let client = clientEmail
        ? await prisma.client.findFirst({ where: { workspaceId: user.workspaceId, email: { equals: clientEmail, mode: "insensitive" } } })
        : await prisma.client.findFirst({ where: { workspaceId: user.workspaceId, name: clientName, company: clientCompany } });

      // The same row imported before (a re-run of the file, or one export
      // covering the last): this client already has a contract deal with
      // this service and fee, signed the same day when the row gives a date.
      if (client) {
        const already = await prisma.deal.findFirst({
          where: { workspaceId: user.workspaceId, clientId: client.id, kind: "contract", trashedAt: null, service, feeDisplay: fee, ...(signedDate ? { contract: { signedAt: sameDay(signedDate) } } : {}) },
          select: { id: true },
        });
        if (already) {
          result.errors.push({ row: rowNum, message: "Already imported: this client has a deal with the same service and fee" });
          result.skipped++;
          continue;
        }
      }

      if (!client) {
        client = await prisma.client.create({
          data: { workspaceId: user.workspaceId, name: clientName, company: clientCompany, email: clientEmail },
        });
      }

      // Every deal is on a lead, so imported history shows on the Leads list.
      const leadId = await leadForClient(user.workspaceId, client, { ownerId: currentUser.id, source: "csv" });
      await prisma.deal.create({
        data: {
          workspaceId: user.workspaceId,
          clientId: client.id,
          leadId,
          ownerId: currentUser.id,
          teamId: currentUser.teamId,
          service,
          feeDisplay: fee,
          status,
          source: "import",
          ...(status === "signed"
            ? { contract: { create: { status: "signed", signedAt: signedDate ?? new Date() } } }
            : {}),
        },
      });
      // A signed import is past history: the lead is a client, quietly (no
      // lead.converted webhook for a deal signed before SealMe saw it).
      if (status === "signed") {
        const at = signedDate ?? new Date();
        await prisma.lead.updateMany({ where: { id: leadId, isClient: false }, data: { isClient: true, clientAt: at, pipelineStage: "client", stage: "converted", convertedAt: at } });
      } else {
        // A sent row gets no contract, so its lead stays at New: a contract
        // marked sent with no document behind it would get reminder emails
        // to the client and sit in Waiting on an answer with nothing to open.
        await refreshLeadPipeline(leadId);
      }

      result.created++;
    } catch (err) {
      result.errors.push({ row: rowNum, message: err instanceof Error ? err.message : "Unknown error" });
      result.skipped++;
    }
  }

  const session = await auth();
  await logAudit({
    workspaceId: user.workspaceId,
    actorEmail: session?.user?.email,
    action: "data.bulk_imported",
    metadata: { created: result.created, skipped: result.skipped },
  });

  revalidatePath("/leads");
  return result;
}
