"use server";

import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { consentFor, isCallTestWorkspace, recordingDecision, type ConsentRule } from "@/lib/call-consent";
import { callAction, isTelnyxConfigured, sealmeNumber } from "@/lib/telnyx";
import { callRep } from "@/lib/telnyx-calls";
import { reportError } from "@/lib/error-report";

// How long a tap on Call waits for the rep's call to reach the SealMe number.
const INTENT_MINUTES = 10;

export type CallPlan =
  // SealMe is ringing the rep's phone; it calls the client once they pick up.
  | { kind: "ringing"; callId: string }
  // Call SealMe first, then add the client and merge (the rep's number
  // isn't verified yet, so SealMe can't call clients from it).
  | { kind: "sealme"; dial: string; leadPhone: string; announce: boolean; state: string | null }
  // SealMe stays off this call: the client is dialed directly.
  | { kind: "direct"; dial: string; reason: ConsentRule | "no_sealme_number"; state: string | null }
  | { kind: "error"; error: string };

// The Call button on a lead (and in Today). When SealMe may record this
// lead and the rep's number is verified, SealMe rings the rep and then the
// client: nothing else to tap. Not verified yet: it notes that the rep is
// about to call, so the call that reaches the SealMe number from their
// phone in the next few minutes is tied to this lead. When SealMe may not
// record, the rep just calls the client.
export async function startLeadCall(leadId: string, input: { mode?: string; templateId?: string | null } = {}): Promise<CallPlan> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  // Nobody has to say what kind of call it is: SealMe tells from the call.
  const mode = input.mode === "cold" || input.mode === "sales" ? input.mode : "auto";

  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, AND: [access.where] }, select: { id: true, phone: true } });
  if (!lead) return { kind: "error", error: "Lead not found" };
  if (!lead.phone) return { kind: "error", error: "This lead has no phone number" };

  const consent = consentFor(lead.phone);
  const number = sealmeNumber();
  if (!number) return { kind: "direct", dial: lead.phone, reason: "no_sealme_number", state: consent.state };
  const { record, announce } = recordingDecision(consent.rule, workspace.allPartyStatePolicy, { testMode: isCallTestWorkspace(workspace.id) });
  if (!record) return { kind: "direct", dial: lead.phone, reason: consent.rule, state: consent.state };

  const me = await prisma.user.findUnique({ where: { id: access.userId }, select: { phone: true, phoneVerifiedAt: true } });
  if (!me?.phone) return { kind: "error", error: "Add your phone number in Settings first, so SealMe knows the call is yours" };

  let templateId: string | null = null;
  if (mode === "sales" && input.templateId) {
    const template = await prisma.contractTemplate.findFirst({ where: { id: input.templateId, workspaceId: workspace.id }, select: { id: true } });
    if (!template) return { kind: "error", error: "That template isn't in this workspace" };
    templateId = template.id;
  }

  // The rep's number is verified: SealMe rings them, then the client.
  if (me.phoneVerifiedAt && isTelnyxConfigured()) {
    const call = await prisma.phoneCall.create({
      data: {
        workspaceId: workspace.id,
        userId: access.userId,
        leadId: lead.id,
        mode,
        templateId,
        source: "phone",
        status: "dialing",
        fromNumber: me.phone,
        toNumber: lead.phone,
        consentState: consent.state,
        consentRule: consent.rule,
        recorded: false,
      },
    });
    try {
      const repLeg = await callRep(call.id, me.phone, announce);
      await prisma.phoneCall.update({ where: { id: call.id }, data: { telnyxCallControlId: repLeg } });
    } catch (err) {
      await prisma.phoneCall.update({ where: { id: call.id }, data: { status: "skipped", extracted: { skipped: "dial_failed" }, processedAt: new Date() } });
      await reportError(err, "Ringing the rep for a call", { callId: call.id });
      return { kind: "error", error: "SealMe couldn't ring your phone. Try again" };
    }
    return { kind: "ringing", callId: call.id };
  }

  // Only the latest tap counts.
  await prisma.callIntent.updateMany({ where: { userId: access.userId, usedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
  await prisma.callIntent.create({
    data: { workspaceId: workspace.id, userId: access.userId, leadId: lead.id, mode, templateId, expiresAt: new Date(Date.now() + INTENT_MINUTES * 60 * 1000) },
  });
  return { kind: "sealme", dial: number, leadPhone: lead.phone, announce, state: consent.state };
}

// "Cancel" while SealMe is still ringing: both legs are ended. The call is
// marked cancelled before the hangups, so the hangup events that follow
// don't record it as the client not picking up.
export async function cancelLeadCall(callId: string): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const { count } = await prisma.phoneCall.updateMany({
    where: { id: callId, workspaceId: workspace.id, userId: access.userId, status: "dialing" },
    data: { status: "skipped", extracted: { skipped: "cancelled" }, processedAt: new Date() },
  });
  // Already past ringing (picked up, or ended on its own).
  if (count === 0) return;
  // Read after the change, so a client leg dialed a moment ago is ended too.
  const call = await prisma.phoneCall.findUnique({ where: { id: callId }, select: { telnyxCallControlId: true, telnyxClientLegId: true } });
  for (const leg of [call?.telnyxClientLegId, call?.telnyxCallControlId]) {
    if (leg) await callAction(leg, "hangup", { command_id: `cancel-${leg}` }).catch(() => {});
  }
}
