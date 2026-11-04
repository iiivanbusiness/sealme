"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { normalizePhone } from "@/lib/phone";
import { checkRateLimit } from "@/lib/rate-limit";
import { confirmVerificationCode, isNumberVerified, isTelnyxConfigured, removeVerifiedNumber, sendVerificationCode } from "@/lib/telnyx";
import { reportError } from "@/lib/error-report";

async function me() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return prisma.user.findUnique({ where: { email }, select: { id: true, phone: true, phoneVerifiedAt: true } });
}

// The number a rep calls the SealMe number from: it's how SealMe knows
// whose call it is. Empty clears it. A new number has to be confirmed again
// before SealMe calls clients from it.
export async function saveMyPhoneNumber(raw: string): Promise<{ error?: string; phone?: string | null }> {
  const user = await me();
  if (!user) return { error: "Not signed in" };

  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const phone = trimmed ? normalizePhone(trimmed) : null;
  if (trimmed && !phone) return { error: "Start with + and your country code, then the number without its leading 0, like +381 64 123 4567 or +1 512 555 0100" };

  try {
    await prisma.user.update({ where: { id: user.id }, data: { phone, ...(phone !== user.phone ? { phoneVerifiedAt: null } : {}) } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { error: "Another SealMe user already has that number" };
    throw err;
  }
  revalidatePath("/settings");
  return { phone };
}

// "Verify by text": Telnyx texts the saved number a code. Always a code,
// even for a number already confirmed at Telnyx: the Telnyx account is
// SealMe's, shared by every workspace, so that confirmation may have been
// someone else's. Such a number is taken off the account first, so Telnyx
// texts a fresh code instead of counting it as already done.
export async function sendMyPhoneCode(): Promise<{ error?: string; verified?: boolean }> {
  const user = await me();
  if (!user) return { error: "Not signed in" };
  if (!user.phone) return { error: "Save your number first" };
  if (!isTelnyxConfigured()) return { error: "Phone calling isn't set up yet" };
  // This user already confirmed this number with a code (a new number
  // clears it). Removing it at Telnyx would only stop their calls until
  // they type a new code.
  if (user.phoneVerifiedAt) return { verified: true };
  if (!(await checkRateLimit(`phone-code:${user.id}`, 5, 60 * 60 * 1000))) return { error: "Too many codes sent. Try again in an hour" };
  try {
    if (await isNumberVerified(user.phone)) await removeVerifiedNumber(user.phone);
    await sendVerificationCode(user.phone);
    return {};
  } catch (err) {
    await reportError(err, "Sending a phone verification code", { userId: user.id });
    return { error: "Couldn't send the code. Check the number and try again" };
  }
}

export async function confirmMyPhoneCode(code: string): Promise<{ error?: string }> {
  const user = await me();
  if (!user?.phone) return { error: "Save your number first" };
  const digits = typeof code === "string" ? code.replace(/\D/g, "") : "";
  if (!digits) return { error: "Type the code from the text" };
  if (!(await checkRateLimit(`phone-confirm:${user.id}`, 10, 60 * 60 * 1000))) return { error: "Too many tries. Try again in an hour" };
  try {
    if (!(await confirmVerificationCode(user.phone, digits))) return { error: "That code didn't match. Check the text, or send a new code" };
  } catch (err) {
    await reportError(err, "Confirming a phone verification code", { userId: user.id });
    return { error: "Couldn't check the code. Try again" };
  }
  await prisma.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: new Date() } });
  revalidatePath("/settings");
  return {};
}
