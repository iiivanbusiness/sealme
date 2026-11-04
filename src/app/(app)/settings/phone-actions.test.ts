import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, telnyx } = vi.hoisted(() => ({
  db: { user: { findUnique: vi.fn(), update: vi.fn() } },
  telnyx: {
    confirmVerificationCode: vi.fn(),
    isNumberVerified: vi.fn(),
    isTelnyxConfigured: vi.fn(),
    removeVerifiedNumber: vi.fn(),
    sendVerificationCode: vi.fn(),
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "rep@acme.test" } }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/telnyx", () => telnyx);

import { sendMyPhoneCode } from "./phone-actions";

const PHONE = "+15125550100";

describe("Verify by text", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    telnyx.isTelnyxConfigured.mockReturnValue(true);
    db.user.findUnique.mockResolvedValue({ id: "u1", phone: PHONE, phoneVerifiedAt: null });
  });

  it("takes a number someone else verified off the account, then texts a code", async () => {
    telnyx.isNumberVerified.mockResolvedValue(true);
    expect(await sendMyPhoneCode()).toEqual({});
    expect(telnyx.removeVerifiedNumber).toHaveBeenCalledWith(PHONE);
    expect(telnyx.sendVerificationCode).toHaveBeenCalledWith(PHONE);
    expect(telnyx.removeVerifiedNumber.mock.invocationCallOrder[0]).toBeLessThan(telnyx.sendVerificationCode.mock.invocationCallOrder[0]);
    // Verified only once the code is typed in.
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("just texts a code for a number Telnyx doesn't know yet", async () => {
    telnyx.isNumberVerified.mockResolvedValue(false);
    expect(await sendMyPhoneCode()).toEqual({});
    expect(telnyx.removeVerifiedNumber).not.toHaveBeenCalled();
    expect(telnyx.sendVerificationCode).toHaveBeenCalledWith(PHONE);
  });

  it("leaves a number this user already confirmed alone", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", phone: PHONE, phoneVerifiedAt: new Date() });
    expect(await sendMyPhoneCode()).toEqual({ verified: true });
    expect(telnyx.isNumberVerified).not.toHaveBeenCalled();
    expect(telnyx.removeVerifiedNumber).not.toHaveBeenCalled();
    expect(telnyx.sendVerificationCode).not.toHaveBeenCalled();
  });

  it("doesn't text a code when the old verification couldn't be removed", async () => {
    telnyx.isNumberVerified.mockResolvedValue(true);
    telnyx.removeVerifiedNumber.mockRejectedValue(new Error("Telnyx verified number delete failed: 500"));
    expect((await sendMyPhoneCode()).error).toMatch(/Couldn't send the code/);
    expect(telnyx.sendVerificationCode).not.toHaveBeenCalled();
  });
});
