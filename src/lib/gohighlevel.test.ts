import { afterEach, describe, expect, it, vi } from "vitest";
import { addGhlNote, addGhlTask, createGhlOpportunity, ghlCallNote, ghlNameParts, listGhlPipelines, upsertGhlContact } from "./gohighlevel";

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

// Answers every request with `reply` and records what was sent.
function mockFetch(reply: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply), { status });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("GoHighLevel requests", () => {
  it("sends the token and API version on every call", async () => {
    const sent = mockFetch({ pipelines: [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New lead" }] }] });
    const pipelines = await listGhlPipelines("pit-abc", "loc 1");
    expect(sent[0].url).toBe("https://services.leadconnectorhq.com/opportunities/pipelines?locationId=loc%201");
    expect(sent[0].headers.Authorization).toBe("Bearer pit-abc");
    expect(sent[0].headers.Version).toBe("2021-07-28");
    expect(pipelines).toEqual([{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New lead" }] }]);
  });

  it("finds or makes the contact, leaving out what isn't known", async () => {
    const sent = mockFetch({ contact: { id: "c1" }, new: true });
    const id = await upsertGhlContact("t", "loc", { name: "Laura Chen", email: "laura@brightline.com", phone: null, company: "Brightline" });
    expect(id).toBe("c1");
    expect(sent[0]).toMatchObject({ url: "https://services.leadconnectorhq.com/contacts/upsert", method: "POST" });
    expect(sent[0].body).toEqual({ locationId: "loc", firstName: "Laura", lastName: "Chen", name: "Laura Chen", email: "laura@brightline.com", companyName: "Brightline", source: "SealMe" });
  });

  it("adds the note, the task and the opportunity", async () => {
    let sent = mockFetch({ note: { id: "n1" } });
    expect(await addGhlNote("t", "c1", "Call notes")).toBe("n1");
    expect(sent[0]).toMatchObject({ url: "https://services.leadconnectorhq.com/contacts/c1/notes", method: "POST", body: { body: "Call notes" } });

    sent = mockFetch({ task: { id: "t1" } });
    await addGhlTask("t", "c1", { title: "Follow up with Laura", body: null, dueDate: new Date("2026-10-28T12:00:00Z") });
    expect(sent[0].url).toBe("https://services.leadconnectorhq.com/contacts/c1/tasks");
    expect(sent[0].body).toEqual({ title: "Follow up with Laura", dueDate: "2026-10-28T12:00:00.000Z", completed: false });

    sent = mockFetch({ opportunity: { id: "o1" } });
    expect(await createGhlOpportunity("t", { locationId: "loc", pipelineId: "p1", stageId: "s1", contactId: "c1", name: "Brightline (Laura Chen)" })).toBe("o1");
    expect(sent[0].body).toEqual({ locationId: "loc", pipelineId: "p1", pipelineStageId: "s1", contactId: "c1", name: "Brightline (Laura Chen)", status: "open" });
  });

  it("says what went wrong when GoHighLevel refuses", async () => {
    mockFetch({ message: "Invalid JWT" }, 401);
    await expect(listGhlPipelines("bad", "loc")).rejects.toThrow(/401/);
  });
});

describe("What a call looks like in GoHighLevel", () => {
  it("splits a name the way GoHighLevel stores it", () => {
    expect(ghlNameParts("Laura Chen")).toEqual({ firstName: "Laura", lastName: "Chen" });
    expect(ghlNameParts("Daniel")).toEqual({ firstName: "Daniel" });
    expect(ghlNameParts("Mary Ann Smith")).toEqual({ firstName: "Mary", lastName: "Ann Smith" });
  });

  it("writes the note with the write-up and the next step", () => {
    const note = ghlCallNote({
      title: "SealMe call: Meeting booked",
      startedAt: new Date("2026-10-26T10:00:00Z"),
      summary: "Laura wants a demo for 25 reps.",
      notes: "- Budget around $30,000 a year",
      nextStep: "Sales call with Laura Chen: demo with IT",
    });
    expect(note).toBe(
      "SealMe call: Meeting booked (Oct 26, 2026)\n\nLaura wants a demo for 25 reps.\n\n- Budget around $30,000 a year\n\nNext step: Sales call with Laura Chen: demo with IT\n\nWritten up by SealMe",
    );
  });
});
