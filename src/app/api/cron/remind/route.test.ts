import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { contract, dispatch, audit, refreshLead } = vi.hoisted(() => ({
  contract: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  dispatch: vi.fn(),
  audit: vi.fn(),
  refreshLead: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract } }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/email", () => ({ sendAdminAlertEmail: vi.fn(), sendReminderEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline: refreshLead }));

import { GET } from "./route";

const sentAt = new Date("2026-11-01T10:00:00Z");
const lapsed = { id: "k1", sentAt, deal: { id: "d1", workspaceId: "w1", leadId: "l1" } };
const cron = () => new Request("https://app.test/api/cron/remind", { headers: { authorization: "Bearer secret" } });

describe("The daily expiry sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.findMany.mockReset();
    vi.stubEnv("CRON_SECRET", "secret");
    // The reminder sweep finds nothing; the expiry sweep finds one lapsed link.
    contract.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([lapsed]);
    contract.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("marks a lapsed SealMe link expired, announces it with its lead, and moves the lead", async () => {
    const res = await GET(cron());
    expect(await res.json()).toEqual({ reminded: 0, expired: 1 });
    // Only SealMe's own sent contracts, never a proposal.
    expect(contract.findMany.mock.calls[1][0].where).toMatchObject({ status: "sent", deliveryMethod: "sealme", deal: { kind: { not: "proposal" } } });
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "k1", status: "sent" }, data: { status: "expired" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contract.expired", targetId: "k1" }));
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.expired", {
      dealId: "d1",
      contractId: "k1",
      leadId: "l1",
      sentAt: sentAt.toISOString(),
      expiredAt: expect.any(String),
    });
    expect(refreshLead).toHaveBeenCalledWith("l1");
  });

  it("keeps a signature that landed in the same second", async () => {
    contract.updateMany.mockResolvedValue({ count: 0 });
    const res = await GET(cron());
    expect(await res.json()).toEqual({ reminded: 0, expired: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
  });

  it("turns away a call without the cron secret", async () => {
    const res = await GET(new Request("https://app.test/api/cron/remind"));
    expect(res.status).toBe(401);
    expect(contract.findMany).not.toHaveBeenCalled();
  });
});
