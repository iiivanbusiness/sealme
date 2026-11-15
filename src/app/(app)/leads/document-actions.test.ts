import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, buildDealFromCall, createContractFromProposalAction } = vi.hoisted(() => ({
  prisma: {
    phoneCall: { findFirst: vi.fn() },
    contractTemplate: { count: vi.fn() },
  },
  buildDealFromCall: vi.fn(),
  createContractFromProposalAction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ canAssign: true, canViewAll: true, userId: "u1", where: {} }) }));
vi.mock("@/lib/call-deal", () => ({ buildDealFromCall }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/app/(app)/deals/[id]/proposal-actions", () => ({ createContractFromProposalAction }));

import { createFromCall } from "./document-actions";

describe("Making a document from a call by hand", () => {
  const call = (extracted: unknown, builtDeals: { id: string; kind: string; status: string }[] = []) => ({
    id: "c1",
    leadId: "l1",
    transcript: "Rep: Hi\nDana: Send it over",
    wantsProposal: true,
    wantsContract: false,
    mode: "cold",
    // Written up a minute ago: the automatic proposal would still be on its way.
    processedAt: new Date(Date.now() - 60_000),
    extracted,
    builtDeals,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.contractTemplate.count.mockResolvedValue(1);
    buildDealFromCall.mockResolvedValue({ dealId: "d9" });
    createContractFromProposalAction.mockResolvedValue({ dealId: "k1", hasMissing: false });
  });

  it("waits for the automatic one while it's being written", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({ summary: "x" }));
    expect((await createFromCall("c1", "proposal")).error).toMatch(/SealMe is writing the proposal/);
    expect(buildDealFromCall).not.toHaveBeenCalled();
  });

  it("makes it right away when the automatic one failed", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({ docFailed: { proposal: true } }));
    expect(await createFromCall("c1", "proposal")).toEqual({ dealId: "d9" });
    // Made for the rep who asked, who's waiting for it on the lead.
    expect(buildDealFromCall).toHaveBeenCalledWith("c1", "proposal", { quiet: true, ownerId: "u1" });
  });

  it("still waits when only the other kind failed", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({ docFailed: { contract: true } }));
    expect((await createFromCall("c1", "proposal")).error).toMatch(/SealMe is writing/);
  });

  it("opens the call's own document instead of making a second", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({}, [{ id: "p1", kind: "proposal", status: "ready" }, { id: "k0", kind: "contract", status: "ready" }]));
    expect(await createFromCall("c1", "contract")).toEqual({ dealId: "k0" });
    expect(await createFromCall("c1", "proposal")).toEqual({ dealId: "p1" });
    expect(createContractFromProposalAction).not.toHaveBeenCalled();
    expect(buildDealFromCall).not.toHaveBeenCalled();
  });

  it("makes the contract from the call's proposal, the way the proposal page does", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({}, [{ id: "p2", kind: "proposal", status: "ready" }]));
    expect(await createFromCall("c1", "contract")).toEqual({ dealId: "k1" });
    expect(createContractFromProposalAction).toHaveBeenCalledWith("p2");
    expect(buildDealFromCall).not.toHaveBeenCalled();
  });

  it("passes on why the contract couldn't be made from the proposal", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({}, [{ id: "p2", kind: "proposal", status: "ready" }]));
    createContractFromProposalAction.mockResolvedValue({ error: "Add a contract template first" });
    expect(await createFromCall("c1", "contract")).toEqual({ error: "Add a contract template first" });
  });

  it("waits while the proposal it would copy is still being written", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({}, [{ id: "p2", kind: "proposal", status: "processing" }]));
    expect((await createFromCall("c1", "contract")).error).toMatch(/still writing the proposal/);
    expect(createContractFromProposalAction).not.toHaveBeenCalled();
  });

  it("makes a contract from the transcript when the call has no proposal", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue(call({}));
    expect(await createFromCall("c1", "contract")).toEqual({ dealId: "d9" });
    expect(buildDealFromCall).toHaveBeenCalledWith("c1", "contract", { quiet: true, ownerId: "u1" });
    expect(createContractFromProposalAction).not.toHaveBeenCalled();
  });
});
