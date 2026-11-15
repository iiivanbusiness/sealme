import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory stand-in for the two tables the delivery code touches.
type Delivery = {
  id: string;
  endpointId: string;
  event: string;
  eventId: string | null;
  payload: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
};
const db = vi.hoisted(() => ({
  endpoints: [] as { id: string; workspaceId: string; url: string; secret: string; events: string; enabled: boolean }[],
  deliveries: [] as Delivery[],
}));

vi.mock("@/lib/db", () => {
  let n = 0;
  const make = (data: Partial<Delivery>): Delivery => ({
    id: `d${++n}`,
    eventId: null,
    payload: null,
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    deliveredAt: null,
    responseStatus: null,
    error: null,
    createdAt: new Date(),
    endpointId: "",
    event: "",
    ...data,
  });
  const apply = (d: Delivery, data: Record<string, unknown>) => {
    const row = d as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as object)) row[k] = (row[k] as number) + (v as { increment: number }).increment;
      else row[k] = v;
    }
  };
  return {
    prisma: {
      deal: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: "deal_1", feeDisplay: "$8.5k a month" }].filter((d) => where.id.in.includes(d.id)),
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === "deal_1"
            ? { id: "deal_1", kind: "contract", leadId: "lead_1", status: "ready", source: "api", service: "Brand refresh", feeDisplay: "$8.5k a month", createdAt: new Date("2026-11-01T12:00:00Z"), client: { id: "cli_1", name: "Avery Chen", company: "Northwind" }, owner: null }
            : null,
      },
      webhookEndpoint: {
        findMany: async ({ where }: { where: { workspaceId: string; enabled: boolean } }) => db.endpoints.filter((e) => e.workspaceId === where.workspaceId && e.enabled === where.enabled),
      },
      webhookDelivery: {
        create: async ({ data }: { data: Partial<Delivery> }) => {
          const d = make(data);
          db.deliveries.push(d);
          return d;
        },
        createManyAndReturn: async ({ data }: { data: Partial<Delivery>[] }) => data.map((x) => {
          const d = make(x);
          db.deliveries.push(d);
          return d;
        }),
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const d = db.deliveries.find((x) => x.id === where.id);
          if (!d) throw new Error("not found");
          return d;
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const d = db.deliveries.find((x) => x.id === where.id);
          return d ? { ...d, endpoint: db.endpoints.find((e) => e.id === d.endpointId) } : null;
        },
        updateMany: async ({ where, data }: { where: { id: string; status: string; attempts: number; nextAttemptAt: { lte: Date } }; data: Record<string, unknown> }) => {
          const d = db.deliveries.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts && x.nextAttemptAt !== null && x.nextAttemptAt <= where.nextAttemptAt.lte);
          if (!d) return { count: 0 };
          apply(d, data);
          return { count: 1 };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const d = db.deliveries.find((x) => x.id === where.id)!;
          apply(d, data);
          return d;
        },
        findMany: async () => db.deliveries.filter((d) => d.status === "pending" && d.nextAttemptAt && d.nextAttemptAt <= new Date() && d.payload),
      },
    },
  };
});
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/outbound-url", () => ({ checkPublicHttpsUrl: async (url: string) => (url.includes("internal") ? "That address isn't reachable from the internet" : null) }));
// Outside a request after() throws; the code then runs the work inline.
vi.mock("next/server", () => ({ after: () => { throw new Error("outside request"); } }));

import { attemptDelivery, dispatchDealCreated, dispatchWebhookEvent, dispatchWebhookEvents, MAX_WEBHOOK_ATTEMPTS, resendWebhookDelivery, retryDueWebhookDeliveries, sendTestWebhook } from "./webhooks";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  db.endpoints = [{ id: "e1", workspaceId: "w1", url: "https://hooks.example.com/in", secret: "whsec_test", events: JSON.stringify(["deal.created", "lead.created"]), enabled: true }];
  db.deliveries = [];
  fetchMock.mockReset();
});

describe("dispatchWebhookEvent", () => {
  it("signs the body and sends the event headers", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await dispatchWebhookEvent("w1", "deal.created", { dealId: "deal_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/in");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ event: "deal.created", data: { dealId: "deal_1" } });
    expect(body.id).toMatch(/^evt_/);
    expect(body.timestamp).toBe(body.created);
    const expected = createHmac("sha256", "whsec_test").update(init.body).digest("hex");
    expect(init.headers["X-SealMe-Signature"]).toBe(`sha256=${expected}`);
    expect(init.headers["X-SealMe-Event"]).toBe("deal.created");
    expect(init.headers["X-SealMe-Event-Id"]).toBe(body.id);
    expect(init.headers["X-SealMe-Attempt"]).toBe("1");
    expect(init.redirect).toBe("manual");
    expect(db.deliveries[0]).toMatchObject({ status: "delivered", attempts: 1, responseStatus: 200, error: null });
  });

  it("links the lead and deal and adds the deal's value as a number", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await dispatchWebhookEvent("w1", "deal.created", { dealId: "deal_1", leadId: "lead_1", contractId: "con_1" });
    const { data } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(data).toMatchObject({
      leadUrl: "https://app.example.com/leads/lead_1",
      dealUrl: "https://app.example.com/deals/deal_1",
      contractUrl: "https://app.example.com/deals/deal_1/contract",
      feeDisplay: "$8.5k a month",
      dealValue: 8500,
      currency: "USD",
    });
    vi.unstubAllEnvs();
  });

  it("says on deal.created whether it's a proposal or a contract, and which lead it's on", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await dispatchDealCreated("w1", "deal_1");
    const { data } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(data).toMatchObject({ dealId: "deal_1", kind: "contract", leadId: "lead_1", leadUrl: "https://app.example.com/leads/lead_1", clientId: "cli_1", dealValue: 8500 });
    vi.unstubAllEnvs();
  });

  it("only builds the events when someone is listening", async () => {
    const build = vi.fn(async () => [{ leadId: "lead_1" }]);
    await dispatchWebhookEvents("w1", "task.completed", build);
    expect(build).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await dispatchWebhookEvents("w1", "lead.created", build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips endpoints that aren't subscribed or are paused", async () => {
    db.endpoints.push({ id: "e2", workspaceId: "w1", url: "https://other.example.com", secret: "s", events: JSON.stringify(["contract.signed"]), enabled: true });
    db.endpoints.push({ id: "e3", workspaceId: "w1", url: "https://paused.example.com", secret: "s", events: JSON.stringify(["deal.created"]), enabled: false });
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await dispatchWebhookEvent("w1", "deal.created", {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.deliveries).toHaveLength(1);
  });

  it("never throws into the caller", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(dispatchWebhookEvent("w1", "deal.created", {})).resolves.toBeUndefined();
  });
});

describe("retries", () => {
  it("schedules the next attempt a minute out after a failure", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    const before = Date.now();
    await dispatchWebhookEvent("w1", "deal.created", {});
    const d = db.deliveries[0];
    expect(d).toMatchObject({ status: "pending", attempts: 1, responseStatus: 503, error: "Answered 503" });
    expect(d.nextAttemptAt!.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(d.nextAttemptAt!.getTime() - before).toBeLessThan(65_000);
  });

  it("gives up after the last attempt, keeping the same event id", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await dispatchWebhookEvent("w1", "deal.created", {});
    const d = db.deliveries[0];
    for (let i = 1; i < MAX_WEBHOOK_ATTEMPTS; i++) {
      d.nextAttemptAt = new Date(Date.now() - 1);
      await retryDueWebhookDeliveries();
    }
    expect(d).toMatchObject({ status: "failed", attempts: MAX_WEBHOOK_ATTEMPTS, nextAttemptAt: null });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_WEBHOOK_ATTEMPTS);
    const ids = new Set(fetchMock.mock.calls.map(([, init]) => init.headers["X-SealMe-Event-Id"]));
    expect(ids.size).toBe(1);
    expect(fetchMock.mock.calls.at(-1)![1].headers["X-SealMe-Attempt"]).toBe(String(MAX_WEBHOOK_ATTEMPTS));
  });

  it("recovers when the endpoint comes back", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await dispatchWebhookEvent("w1", "deal.created", {});
    db.deliveries[0].nextAttemptAt = new Date(Date.now() - 1);
    await retryDueWebhookDeliveries();
    expect(db.deliveries[0]).toMatchObject({ status: "delivered", attempts: 2, responseStatus: 204, error: null, nextAttemptAt: null });
  });

  it("treats redirects and timeouts as failures with a readable reason", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://elsewhere" } }));
    await dispatchWebhookEvent("w1", "deal.created", {});
    expect(db.deliveries[0].error).toMatch(/Redirects/);

    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    fetchMock.mockRejectedValueOnce(timeout);
    await dispatchWebhookEvent("w1", "deal.created", {});
    expect(db.deliveries[1].error).toMatch(/10 seconds/);
  });

  it("never sends one delivery twice at the same time", async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = () => resolve(new Response("ok", { status: 200 })); }));
    db.deliveries.push({ id: "dx", endpointId: "e1", event: "deal.created", eventId: "evt_x", payload: "{}", status: "pending", attempts: 0, nextAttemptAt: new Date(), deliveredAt: null, responseStatus: null, error: null, createdAt: new Date() });
    const first = attemptDelivery("dx");
    await new Promise((r) => setTimeout(r, 0));
    await attemptDelivery("dx");
    release();
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the endpoint is paused", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await dispatchWebhookEvent("w1", "deal.created", {});
    db.endpoints[0].enabled = false;
    db.deliveries[0].nextAttemptAt = new Date(Date.now() - 1);
    await retryDueWebhookDeliveries();
    expect(db.deliveries[0]).toMatchObject({ status: "failed", error: "Endpoint paused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to send to an address that isn't public", async () => {
    db.endpoints[0].url = "https://db.internal/hook";
    await dispatchWebhookEvent("w1", "deal.created", {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.deliveries[0].error).toMatch(/reachable/);
  });
});

describe("test and resend", () => {
  it("sends a test event once, without retries", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await sendTestWebhook("e1");
    expect(db.deliveries[0]).toMatchObject({ event: "test", status: "failed", attempts: 1 });
  });

  it("resends a failed event with the same event id", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    db.deliveries.push({ id: "old", endpointId: "e1", event: "deal.created", eventId: "evt_same", payload: "{\"id\":\"evt_same\"}", status: "failed", attempts: 7, nextAttemptAt: null, deliveredAt: null, responseStatus: 500, error: "Answered 500", createdAt: new Date() });
    await resendWebhookDelivery("old");
    const fresh = db.deliveries.find((d) => d.id !== "old")!;
    expect(fresh).toMatchObject({ eventId: "evt_same", status: "delivered", attempts: 1 });
    expect(fetchMock.mock.calls[0][1].body).toBe("{\"id\":\"evt_same\"}");
  });
});
