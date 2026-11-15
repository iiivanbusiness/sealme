import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, logAudit, sendProposalReminderEmail, isEmailConfigured, revalidatePath, reportError } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn() },
    contract: { updateMany: vi.fn() },
    lead: { updateMany: vi.fn() },
    auditLog: { findFirst: vi.fn() },
  },
  logAudit: vi.fn(),
  sendProposalReminderEmail: vi.fn(),
  isEmailConfigured: vi.fn(),
  revalidatePath: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: { ownerId: "u1" }, userId: "u1" }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "ana@agency.test" } }) }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/error-report", () => ({ reportError }));
vi.mock("@/lib/email", () => ({ sendProposalReminderEmail, isEmailConfigured }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call", PLACEHOLDER_CLIENT: "New client" }));

import { recordReminderLinkCopied, sendDocumentReminder } from "./reminder-actions";

const LAST_REMINDER = new Date("2026-11-01T10:00:00Z");

function proposalDeal(contract: Record<string, unknown> | null = {}, overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    kind: "proposal",
    trashedAt: null,
    leadId: "lead1",
    client: { name: "Priya Shah", email: "priya@acme.test" },
    lead: { name: "Priya Shah", email: "lead@acme.test" },
    workspace: { name: "Agency", senderEmail: null, senderDomainStatus: null },
    contract: contract && { id: "k1", status: "sent", reminderSentAt: LAST_REMINDER, ...contract },
    ...overrides,
  };
}

describe("Send reminder on a proposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.auditLog.findFirst.mockResolvedValue(null);
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    sendProposalReminderEmail.mockResolvedValue(undefined);
    isEmailConfigured.mockReturnValue(true);
  });

  it("looks the deal up with the rep's visibility", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    expect(await sendDocumentReminder("d1")).toEqual({ error: "Proposal not found" });
    expect(prisma.deal.findFirst.mock.calls[0][0].where).toEqual({ id: "d1", workspaceId: "w1", ownerId: "u1" });
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
  });

  it("emails the client the proposal's link, once, and puts it on the record", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal());

    expect(await sendDocumentReminder("d1")).toEqual({ sentTo: "priya@acme.test" });

    const claim = prisma.contract.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "k1", status: "sent" });
    expect(claim.where.OR[0]).toEqual({ reminderSentAt: null });
    expect(claim.where.OR[1].reminderSentAt.lt).toBeInstanceOf(Date);
    expect(claim.data.reminderSentAt).toBeInstanceOf(Date);

    expect(sendProposalReminderEmail).toHaveBeenCalledTimes(1);
    expect(sendProposalReminderEmail.mock.calls[0][0]).toMatchObject({
      to: "priya@acme.test",
      clientName: "Priya Shah",
      workspaceName: "Agency",
      replyTo: "ana@agency.test",
      verifiedSenderEmail: null,
    });
    expect(sendProposalReminderEmail.mock.calls[0][0].proposalLink).toMatch(/\/proposal\/k1$/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.reminder_sent", targetType: "Deal", targetId: "d1", metadata: { to: "priya@acme.test" } }));
    // The rep worked the lead.
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: "lead1", workspaceId: "w1" }, data: { lastActivityAt: claim.data.reminderSentAt } });
    // The Dashboard isn't refreshed from here: the row would leave Needs you
    // before "Reminder sent" could be seen. The button refreshes it.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says plainly when email isn't set up, and takes nothing", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal());
    isEmailConfigured.mockReturnValue(false);

    expect(await sendDocumentReminder("d1")).toEqual({ error: "Email sending isn't set up yet, so the reminder wasn't sent" });
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("goes to the address the proposal was emailed to, from the workspace's own domain when it has one", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { client: { name: "New client", email: null }, lead: { name: "New lead from a call", email: null }, workspace: { name: "Agency", senderEmail: "hello@agency.test", senderDomainStatus: "verified" } }));
    prisma.auditLog.findFirst.mockResolvedValue({ metadata: JSON.stringify({ to: "jane@acme.test" }) });

    expect(await sendDocumentReminder("d1")).toEqual({ sentTo: "jane@acme.test" });
    expect(prisma.auditLog.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "w1", action: "proposal.sent", targetType: "Deal", targetId: "d1" });
    // No name yet: no "Hi New,".
    expect(sendProposalReminderEmail.mock.calls[0][0]).toMatchObject({ to: "jane@acme.test", clientName: null, verifiedSenderEmail: "hello@agency.test" });
  });

  it("refuses a contract, one in the trash and one that isn't out", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { kind: "contract" }));
    expect(await sendDocumentReminder("d1")).toEqual({ error: "Reminders from SealMe are for proposals only" });

    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { trashedAt: new Date() }));
    expect((await sendDocumentReminder("d1")).error).toContain("trash");

    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "draft" }));
    expect(await sendDocumentReminder("d1")).toEqual({ error: "This proposal isn't out with the client" });

    prisma.deal.findFirst.mockResolvedValue(proposalDeal(null));
    expect(await sendDocumentReminder("d1")).toEqual({ error: "This proposal isn't out with the client" });

    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
  });

  it("refuses a client with no email", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { client: { name: "Priya Shah", email: null }, lead: { name: "Priya Shah", email: null } }));
    expect((await sendDocumentReminder("d1")).error).toContain("no email");
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
  });

  it("sends nothing on a second click within the 5 days", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal());
    prisma.contract.updateMany.mockResolvedValue({ count: 0 });

    expect(await sendDocumentReminder("d1")).toEqual({ error: "Already reminded in the last 5 days" });
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it("gives the slot back when the email fails", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal());
    sendProposalReminderEmail.mockRejectedValue(new Error("Resend is down"));

    expect((await sendDocumentReminder("d1")).error).toContain("Couldn't send");

    expect(prisma.contract.updateMany).toHaveBeenCalledTimes(2);
    const claimedAt = prisma.contract.updateMany.mock.calls[0][0].data.reminderSentAt;
    expect(prisma.contract.updateMany.mock.calls[1][0]).toEqual({ where: { id: "k1", reminderSentAt: claimedAt }, data: { reminderSentAt: LAST_REMINDER } });
    expect(reportError).toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

describe("Copy link for a reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
  });

  it("counts as the reminder, without emailing anyone", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { client: { name: "Priya Shah", email: null }, lead: null, leadId: null }));

    expect(await recordReminderLinkCopied("d1")).toEqual({});
    expect(prisma.contract.updateMany.mock.calls[0][0].where).toMatchObject({ id: "k1", status: "sent" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.reminder_link_copied", targetId: "d1" }));
    expect(sendProposalReminderEmail).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("only copies when it was already counted in the last 5 days", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal());
    prisma.contract.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordReminderLinkCopied("d1")).toEqual({});
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("refuses a contract", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({}, { kind: "contract" }));
    expect((await recordReminderLinkCopied("d1")).error).toBeTruthy();
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
  });
});
