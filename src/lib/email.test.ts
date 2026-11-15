import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

import { sendProposalReminderEmail } from "./email";

const reminder = { to: "priya@acme.test", clientName: "Priya Shah", workspaceName: "Agency", proposalLink: "https://app.test/proposal/k1", replyTo: "ana@agency.test" };

describe("The proposal reminder email", () => {
  const key = process.env.RESEND_API_KEY;
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue({ data: { id: "e1" }, error: null });
  });
  afterEach(() => {
    if (key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = key;
  });

  it("says plainly that email isn't set up, and sends nothing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendProposalReminderEmail(reminder)).rejects.toThrow("Email sending isn't set up yet");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the link to the client, with replies going to the rep", async () => {
    process.env.RESEND_API_KEY = "re_test";
    await sendProposalReminderEmail(reminder);
    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0][0];
    expect(email).toMatchObject({ to: "priya@acme.test", subject: "Following up on your proposal from Agency", replyTo: "ana@agency.test" });
    expect(email.html).toContain("https://app.test/proposal/k1");
    expect(email.html).toContain("Hi Priya,");
  });

  it("throws what Resend said when it turns the email down", async () => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockResolvedValue({ data: null, error: { message: "Invalid `to` field", statusCode: 422, name: "validation_error" } });
    await expect(sendProposalReminderEmail(reminder)).rejects.toThrow("Invalid `to` field");
  });
});
