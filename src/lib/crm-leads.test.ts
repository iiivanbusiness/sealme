import { beforeEach, describe, expect, it, vi } from "vitest";

const { lead, client } = vi.hoisted(() => ({ lead: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, client: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: { lead, client } }));
vi.mock("@/lib/notifications", () => ({ createNotification: async () => {} }));
vi.mock("@/lib/tasks", () => ({ isValidTimeZone: () => true }));
vi.mock("@/lib/webhooks", () => ({ dispatchLeadsCreated: async () => {} }));

import { clientCrmIds, upsertCrmLead, type CrmLeadRecord } from "./crm-leads";
import { existingHubspotContactId, hubspotNameParts } from "./hubspot";

const ctx = { members: new Map(), teamOwnedOnly: false };
const record = (o: Partial<CrmLeadRecord> = {}): CrmLeadRecord => ({
  source: "hubspot",
  externalId: "884843816141",
  name: "Jordan Lee",
  company: "Harbor Logistics",
  title: null,
  email: null,
  phone: null,
  domain: null,
  ownerEmail: null,
  ...o,
});

describe("Leads from the CRM", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lead.create.mockResolvedValue({ id: "lead1" });
  });

  it("skips a contact SealMe pushed for one of its own clients", async () => {
    lead.findFirst.mockResolvedValue(null);
    client.findFirst.mockResolvedValue({ id: "client1" });
    const result = await upsertCrmLead("ws1", record(), ctx);
    expect(result.outcome).toBe("skipped");
    expect(client.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws1", hubspotContactId: "884843816141" }, select: { id: true } });
    expect(lead.create).not.toHaveBeenCalled();
  });

  it("still brings in a new contact nobody in SealMe has", async () => {
    lead.findFirst.mockResolvedValue(null);
    client.findFirst.mockResolvedValue(null);
    const result = await upsertCrmLead("ws1", record(), ctx);
    expect(result.outcome).toBe("created");
    expect(lead.create).toHaveBeenCalledOnce();
  });

  it("doesn't look for clients behind a Salesforce Lead", async () => {
    lead.findFirst.mockResolvedValue(null);
    await upsertCrmLead("ws1", record({ source: "salesforce", recordType: "Lead", externalId: "00Q1" }), ctx);
    expect(client.findFirst).not.toHaveBeenCalled();
    expect(lead.create).toHaveBeenCalledOnce();
  });

  // A lead that two HubSpot contacts were merged into: it kept H1, and the
  // other contact's id is an alias.
  const merged = {
    id: "lead9",
    name: "Jordan Lee",
    company: null,
    title: "COO",
    email: null,
    phone: null,
    domain: null,
    externalOwnerEmail: null,
    ownerId: "u1",
    hubspotContactId: "H1",
    salesforceRecordId: null,
    mergedCrmIds: ["hubspot:884843816141"],
  };

  it("updates the lead a merged duplicate went into instead of bringing it back", async () => {
    lead.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(merged);
    const members = new Map([["bob@acme.com", { id: "u2", name: "Bob", timezone: null }]]);
    const result = await upsertCrmLead("ws1", record({ name: "J. Lee", title: "CEO", ownerEmail: "bob@acme.com" }), { members, teamOwnedOnly: false });
    expect(lead.findFirst).toHaveBeenNthCalledWith(2, { where: { workspaceId: "ws1", mergedCrmIds: { has: "hubspot:884843816141" } } });
    expect(lead.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "updated", leadId: "lead9", assignedTo: null });
    // H1 still says who the person is and who owns them; the duplicate only fills gaps.
    expect(lead.update).toHaveBeenCalledWith({ where: { id: "lead9" }, data: { company: "Harbor Logistics", externalOwnerEmail: "bob@acme.com" } });
  });

  it("links a merged lead that has no record of its own in that CRM", async () => {
    lead.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...merged, hubspotContactId: null });
    await upsertCrmLead("ws1", record(), ctx);
    expect(lead.update).toHaveBeenCalledWith({ where: { id: "lead9" }, data: { company: "Harbor Logistics", hubspotContactId: "884843816141" } });
  });

  it("carries the lead's CRM record over to its client", () => {
    expect(clientCrmIds({ hubspotContactId: "123", salesforceRecordId: null, salesforceRecordType: null })).toEqual({ hubspotContactId: "123" });
    expect(clientCrmIds({ hubspotContactId: null, salesforceRecordId: "003A", salesforceRecordType: "Contact" })).toEqual({ salesforceContactId: "003A" });
    expect(clientCrmIds({ hubspotContactId: null, salesforceRecordId: "00QA", salesforceRecordType: "Lead" })).toEqual({});
  });
});

describe("Names sent to HubSpot", () => {
  it("splits first and last name", () => {
    expect(hubspotNameParts("Jordan Lee")).toEqual({ firstname: "Jordan", lastname: "Lee" });
    // A duplicate email points at the contact HubSpot already has.
    expect(existingHubspotContactId(new Error('HubSpot API /crm/v3/objects/contacts failed: 409 {"message":"Contact already exists. Existing ID: 885468517591"}'))).toBe("885468517591");
    expect(existingHubspotContactId(new Error("HubSpot API /crm/v3/objects/contacts failed: 400 bad property"))).toBeNull();
    expect(hubspotNameParts("  Ana  de la Cruz ")).toEqual({ firstname: "Ana", lastname: "de la Cruz" });
    expect(hubspotNameParts("Acme")).toEqual({ firstname: "Acme" });
  });
});
