import { beforeEach, describe, expect, it, vi } from "vitest";

const { lead } = vi.hoisted(() => ({ lead: { findFirst: vi.fn(), create: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: { lead } }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call" }));

import { leadForCall } from "./call-lead";

const visible = { OR: [{ ownerId: "u1" }] };
const made = () => lead.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  lead.findFirst.mockResolvedValue(null);
  lead.create.mockResolvedValue({ id: "l-new" });
});

describe("Who a call is with", () => {
  it("names a lead started from a meeting's email with the meeting's name", async () => {
    expect(await leadForCall("w1", "u1", "new", "Kim@Client.com", visible, "Kim Park")).toEqual({ id: "l-new", fresh: false });
    expect(made()).toMatchObject({ name: "Kim Park", email: "kim@client.com", ownerId: "u1" });
  });

  it("leaves the call to name a lead started from an email alone", async () => {
    expect(await leadForCall("w1", "u1", "new", "kim@client.com", visible)).toEqual({ id: "l-new", fresh: true });
    expect(made()).toMatchObject({ name: "New lead from a call", email: "kim@client.com" });
  });

  it("goes to the lead already on file with that email, whatever the meeting calls them", async () => {
    lead.findFirst.mockResolvedValue({ id: "l-kim" });
    expect(await leadForCall("w1", "u1", "new", "kim@client.com", visible, "K. Park")).toEqual({ id: "l-kim", fresh: false });
    expect(lead.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: "w1", AND: [visible], email: { equals: "kim@client.com", mode: "insensitive" } });
    expect(lead.create).not.toHaveBeenCalled();
  });

  it("takes a typed name as the name, not the meeting's", async () => {
    await leadForCall("w1", "u1", "new", "Kim Park", visible, "Someone else");
    expect(made()).toMatchObject({ name: "Kim Park", email: null });
  });
});
