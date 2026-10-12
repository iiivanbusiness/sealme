"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { scheduleWebhookRetries } from "@/lib/webhooks";
import { isPhoneApp } from "@/lib/phone-app-server";

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  linkUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

// Called both from AppShell (server component, initial render) and from
// NotificationBell's client-side poll — same function either way, this
// file's "use server" makes it network-callable from the client bundle
// without a separate API route.
export async function getUnreadNotifications(): Promise<{ unreadCount: number; items: NotificationItem[] }> {
  // Open tabs poll this, so it doubles as the clock for webhook retries.
  scheduleWebhookRetries();
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { unreadCount: 0, items: [] };
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return { unreadCount: 0, items: [] };

  // The iPhone app has no contracts, so no contract or review news either.
  const mine = (await isPhoneApp())
    ? { userId: user.id, NOT: [{ type: { startsWith: "contract." } }, { type: { startsWith: "review." } }] }
    : { userId: user.id };
  const [unreadCount, rows] = await Promise.all([
    prisma.notification.count({ where: { ...mine, readAt: null } }),
    prisma.notification.findMany({ where: mine, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  return {
    unreadCount,
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      linkUrl: n.linkUrl,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

// Scoped to `userId: currentUser.id` so a viewer can only ever mark their
// own notifications read, never someone else's by guessing an id.
export async function markNotificationRead(id: string) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;
  await prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
  revalidatePath("/", "layout");
}

export async function markAllNotificationsRead() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/", "layout");
}
