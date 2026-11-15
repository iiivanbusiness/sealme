"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentUserWithRole } from "@/lib/permissions";

// Puts "Get started" away for the signed-in person.
export async function hideGetStarted(): Promise<void> {
  const user = await currentUserWithRole();
  await prisma.user.update({ where: { id: user.id }, data: { getStartedHiddenAt: new Date() } });
  revalidatePath("/dashboard");
}
