import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, auth, renderToBuffer, seal } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), updateMany: vi.fn() },
  auth: vi.fn(),
  renderToBuffer: vi.fn(),
  seal: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract } }));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/pdf-sign", () => ({ embedTamperEvidentSignature: seal, isPdfSigningConfigured: () => true }));
vi.mock("@react-pdf/renderer", async (importOriginal) => ({ ...(await importOriginal<typeof import("@react-pdf/renderer")>()), renderToBuffer }));

import { GET } from "./route";

const TEMPLATE = { name: "Retainer", clauses: JSON.stringify([{ title: "Fees", body: "The fee is {fee}." }]) };
// What the client signed: the fee as it went out.
const SENT = { templateName: "Retainer", agencyName: "Agency", clientName: "Brightline Software", clauses: [{ title: "Fees", body: "The fee is $8,500." }] };
const clientSignedAt = new Date("2026-11-10T15:00:00Z");
const cfoSignedAt = new Date("2026-11-11T09:00:00Z");

// The rep raised the fee to $12,000 after the client signed the $8,500 one.
function row(status: string) {
  return {
    id: "k1",
    status,
    deliveryMethod: "sealme",
    expiresAt: null,
    snapshot: SENT,
    template: TEMPLATE,
    signerName: "Priya Shah",
    signedAt: clientSignedAt,
    signatureImage: "data:image/png;base64,client",
    deal: {
      workspaceId: "w1",
      kind: "contract",
      client: { name: "Priya Shah", company: "Brightline Software" },
      fields: [{ fieldKey: "fee", value: "$12,000" }],
      workspace: { name: "Agency", logoImage: null },
    },
    // Only the signed ones: the route asks for status "signed".
    signers: [{ name: "Dana Cole", role: "CFO", signedAt: cfoSignedAt, signatureImage: "data:image/png;base64,cfo" }],
  };
}

const download = () => GET(new Request("https://app.test/api/contracts/k1/pdf"), { params: Promise.resolve({ id: "k1" }) });
const rendered = () => renderToBuffer.mock.calls[0][0].props;

describe("Contract PDF download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderToBuffer.mockResolvedValue(Buffer.from("%PDF"));
    seal.mockImplementation(async (buffer: Buffer) => buffer);
  });

  it("leaves the signatures off the team's copy of a contract marked not signed after the client signed", async () => {
    auth.mockResolvedValue({ user: { workspaceId: "w1" } });
    contract.findUnique.mockResolvedValue(row("not_signed"));
    const res = await download();
    expect(res.status).toBe(200);
    const props = rendered();
    // The reworked terms the team is about to send again.
    expect(props.clauses).toEqual([{ title: "Fees", body: "The fee is $12,000." }]);
    // Nobody signed those, so no signature sits under them.
    expect(props.signedBy).toBeNull();
    expect(props.signedAt).toBeNull();
    expect(props.signatureImage).toBeNull();
    expect(props.countersigners).toEqual([]);
    expect(seal).not.toHaveBeenCalled();
  });

  it("keeps the client's signature under the terms they signed for anyone outside the team", async () => {
    auth.mockResolvedValue(null);
    contract.findUnique.mockResolvedValue(row("not_signed"));
    await download();
    const props = rendered();
    expect(props.clauses).toEqual(SENT.clauses);
    expect(props.signedBy).toBe("Priya Shah");
    expect(props.signatureImage).toBe("data:image/png;base64,client");
    expect(props.countersigners).toHaveLength(1);
  });

  it("shows a signed contract as it was signed, every signature and the seal", async () => {
    auth.mockResolvedValue({ user: { workspaceId: "w1" } });
    contract.findUnique.mockResolvedValue(row("signed"));
    await download();
    const props = rendered();
    expect(props.clauses).toEqual(SENT.clauses);
    expect(props.signedBy).toBe("Priya Shah");
    expect(props.signedAt).toEqual(clientSignedAt);
    expect(props.signatureImage).toBe("data:image/png;base64,client");
    expect(props.countersigners).toEqual([{ name: "Dana Cole", role: "CFO", signedAt: cfoSignedAt, signatureImage: "data:image/png;base64,cfo" }]);
    expect(seal).toHaveBeenCalledWith(expect.any(Buffer), { signerName: "Priya Shah, Dana Cole", signedAt: cfoSignedAt });
    expect(contract.updateMany).not.toHaveBeenCalled();
  });

  it("gives anyone outside the team nothing for a draft that never went out", async () => {
    auth.mockResolvedValue(null);
    for (const status of ["draft", "pending_approval", "changes_requested"]) {
      contract.findUnique.mockResolvedValueOnce({ ...row(status), sentAt: null });
      expect((await download()).status).toBe(404);
    }
    expect(renderToBuffer).not.toHaveBeenCalled();
  });

  it("gives anyone outside the team nothing from the trash, even once it went out", async () => {
    auth.mockResolvedValue({ user: { workspaceId: "other" } });
    const trashed = row("sent");
    contract.findUnique.mockResolvedValue({ ...trashed, sentAt: new Date("2026-11-09T10:00:00Z"), deal: { ...trashed.deal, trashedAt: new Date() } });
    expect((await download()).status).toBe(404);
    expect(renderToBuffer).not.toHaveBeenCalled();
  });

  it("still gives the client a contract that went out and is being reworked", async () => {
    auth.mockResolvedValue(null);
    contract.findUnique.mockResolvedValue({ ...row("changes_requested"), sentAt: new Date("2026-11-09T10:00:00Z") });
    expect((await download()).status).toBe(200);
    // What they were sent, not the reworked terms.
    expect(rendered().clauses).toEqual(SENT.clauses);
  });

  it("lets the team download its own draft, and one in the trash", async () => {
    auth.mockResolvedValue({ user: { workspaceId: "w1" } });
    const draft = { ...row("draft"), sentAt: null, snapshot: null, signedAt: null, signerName: null, signatureImage: null, signers: [] };
    contract.findUnique.mockResolvedValueOnce(draft).mockResolvedValueOnce({ ...draft, deal: { ...draft.deal, trashedAt: new Date() } });
    expect((await download()).status).toBe(200);
    expect((await download()).status).toBe(200);
    expect(renderToBuffer).toHaveBeenCalledTimes(2);
  });
});
