import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract } = vi.hoisted(() => ({ contract: { updateMany: vi.fn(), findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: { contract } }));

import { Prisma } from "@/generated/prisma/client";
import { buildContractSnapshot, parseContractSnapshot, pickContractText, readContractText, showsLiveTerms, type ContractSnapshot } from "./contract-snapshot";

const now = new Date("2026-11-05T12:00:00Z");
const TEMPLATE = { name: "Retainer", clauses: JSON.stringify([{ title: "Parties", body: "Between Agency and {clientName}" }, { title: "Fees", body: "The fee is {fee}." }]) };
const deal = (fee: string) => ({
  fields: [
    { fieldKey: "clientName", value: "Brightline Software Inc." },
    { fieldKey: "fee", value: fee },
  ],
  client: { name: "Priya Shah", company: "Brightline Software" },
  workspace: { name: "Agency" },
});
const SENT: ContractSnapshot = {
  templateName: "Retainer",
  agencyName: "Agency",
  clientName: "Brightline Software Inc.",
  clauses: [
    { title: "Parties", body: "Between Agency and Brightline Software Inc." },
    { title: "Fees", body: "The fee is $5,000 / month." },
  ],
};

function source(status: string, extra: { snapshot?: unknown; template?: typeof TEMPLATE | null; expiresAt?: Date | null; deliveryMethod?: string; fee?: string } = {}) {
  return {
    id: "k1",
    status,
    deliveryMethod: extra.deliveryMethod ?? "sealme",
    expiresAt: extra.expiresAt ?? null,
    snapshot: extra.snapshot ?? null,
    template: extra.template === undefined ? TEMPLATE : extra.template,
    deal: deal(extra.fee ?? "$8,000 / month"),
  };
}

describe("contract snapshot", () => {
  it("captures the filled clauses, the template's name and both parties", () => {
    expect(buildContractSnapshot(TEMPLATE, deal("$5,000 / month"))).toEqual(SENT);
  });

  it("reads back only a whole snapshot", () => {
    expect(parseContractSnapshot(JSON.parse(JSON.stringify(SENT)))).toEqual(SENT);
    expect(parseContractSnapshot({ ...SENT, extra: true })).toEqual(SENT);
    for (const bad of [null, undefined, "text", [SENT], { ...SENT, clientName: undefined }, { ...SENT, clauses: "Fees" }, { ...SENT, clauses: [{ title: "Fees" }] }, { ...SENT, clauses: [null] }]) {
      expect(parseContractSnapshot(bad)).toBeNull();
    }
  });
});

describe("which text a contract shows", () => {
  it("keeps what was sent, however the terms changed since", () => {
    for (const status of ["sent", "partially_signed", "signed", "expired", "changes_requested", "pending_approval"]) {
      expect(pickContractText(source(status, { snapshot: SENT }))).toEqual({ text: SENT, freeze: false });
    }
    // The template was deleted after the send.
    expect(pickContractText(source("signed", { snapshot: SENT, template: null }))?.text).toEqual(SENT);
  });

  it("freezes a contract that went out before snapshots existed", () => {
    for (const status of ["sent", "partially_signed", "signed", "expired"]) {
      const picked = pickContractText(source(status));
      expect(picked?.freeze).toBe(true);
      expect(picked?.text.clauses[1].body).toBe("The fee is $8,000 / month.");
    }
  });

  it("shows the live text of one that never went out", () => {
    for (const status of ["draft", "pending_approval", "changes_requested"]) {
      const picked = pickContractText(source(status));
      expect(picked?.freeze).toBe(false);
      expect(picked?.text.clauses[1].body).toBe("The fee is $8,000 / month.");
    }
    expect(pickContractText(source("draft", { template: null }))).toBeNull();
  });

  it("previews the live terms for the team only while the contract is being worked on", () => {
    for (const status of ["draft", "pending_approval", "changes_requested", "expired"]) expect(showsLiveTerms(source(status), now)).toBe(true);
    for (const status of ["sent", "partially_signed", "signed"]) expect(showsLiveTerms(source(status), now)).toBe(false);
    const lapsed = new Date("2026-11-05T11:00:00Z");
    expect(showsLiveTerms(source("sent", { expiresAt: lapsed }), now)).toBe(true);
    // DocuSign runs its own expiry.
    expect(showsLiveTerms(source("sent", { expiresAt: lapsed, deliveryMethod: "docusign" }), now)).toBe(false);
  });
});

describe("reading a contract's text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the text of an old sent contract once, only where none is stored yet", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    const text = await readContractText(source("signed"));
    expect(text?.clauses[1].body).toBe("The fee is $8,000 / month.");
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "k1", snapshot: { equals: Prisma.DbNull } }, data: { snapshot: text } });
  });

  it("goes with the stored one when a send or another reader got there first", async () => {
    contract.updateMany.mockResolvedValue({ count: 0 });
    contract.findUnique.mockResolvedValue({ snapshot: SENT });
    expect(await readContractText(source("sent"))).toEqual(SENT);
  });

  it("writes nothing for a stored snapshot or a contract that never went out", async () => {
    expect(await readContractText(source("signed", { snapshot: SENT }))).toEqual(SENT);
    expect((await readContractText(source("draft")))?.clauses[1].body).toBe("The fee is $8,000 / month.");
    expect(contract.updateMany).not.toHaveBeenCalled();
  });

  it("gives the team the live terms while reworking, and what the client got once it's out", async () => {
    expect((await readContractText(source("changes_requested", { snapshot: SENT }), { asTeam: true }))?.clauses[1].body).toBe("The fee is $8,000 / month.");
    expect(await readContractText(source("changes_requested", { snapshot: SENT }))).toEqual(SENT);
    expect(await readContractText(source("signed", { snapshot: SENT }), { asTeam: true })).toEqual(SENT);
    // No template left to preview: what was sent is all there is.
    expect(await readContractText(source("expired", { snapshot: SENT, template: null }), { asTeam: true })).toEqual(SENT);
    expect(contract.updateMany).not.toHaveBeenCalled();
  });
});
