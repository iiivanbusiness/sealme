import { prisma } from "@/lib/db";
import { sendTaskDigestEmail, taskDigestEmail, type TaskDigestItem } from "@/lib/email";
import { isValidTimeZone, TASK_TYPE_LABEL } from "@/lib/tasks";
import { dayInZone } from "@/lib/viewer-time";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 15;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
// Used when we've never seen someone's browser: the customers are in the US.
const FALLBACK_TZ = "America/New_York";

const PLURAL: Record<string, [string, string]> = {
  cold_call: ["cold call", "cold calls"],
  sales_call: ["sales call", "sales calls"],
  follow_up: ["follow-up", "follow-ups"],
  other: ["other task", "other tasks"],
};

// One email per person per day with their open tasks: overdue plus what's
// due on their day. Runs from the daily cron (09:00 UTC, early morning in
// the US). Where it's already evening when the cron runs (Hawaii, say),
// the email covers tomorrow instead. taskDigestSentOn stops a second send
// for the same day.
export async function runTaskDigest(options: { workspaceId?: string } = {}): Promise<{ checked: number; sent: number }> {
  const now = new Date();
  const users = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      taskDigestEmail: true,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      assignedTasks: { some: { status: "open", dueDate: { lte: new Date(now.getTime() + 2 * DAY_MS) } } },
    },
    select: { id: true, name: true, email: true, timezone: true, taskDigestSentOn: true, assignedTasks: { take: 1, orderBy: { createdAt: "desc" }, select: { timezone: true } } },
  });

  let sent = 0;
  for (const user of users) {
    try {
      const guess = user.assignedTasks[0]?.timezone;
      const tz = user.timezone && isValidTimeZone(user.timezone) ? user.timezone : guess && isValidTimeZone(guess) ? guess : FALLBACK_TZ;
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
      const isToday = hour < 18;
      const day = dayInZone(isToday ? now : new Date(now.getTime() + DAY_MS), tz);
      if (user.taskDigestSentOn === day) continue;
      const dayDate = new Date(`${day}T00:00:00Z`);

      const tasks = await prisma.task.findMany({
        where: { assigneeId: user.id, status: "open", dueDate: { lte: dayDate } },
        select: { type: true, dueDate: true, dueTime: true, priority: true, lead: { select: { name: true, company: true } } },
        orderBy: [{ dueDate: "asc" }, { dueTime: "asc" }],
        take: 500,
      });
      if (tasks.length === 0) continue;

      const overdue = tasks.filter((t) => t.dueDate < dayDate);
      const onDay = tasks
        .filter((t) => t.dueDate.getTime() === dayDate.getTime())
        .sort((a, b) => (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99") || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2));
      const counts = new Map<string, number>();
      for (const t of onDay) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
      const summary = [...counts.entries()].map(([type, n]) => `${n} ${(PLURAL[type] ?? PLURAL.other)[n === 1 ? 0 : 1]}`).join(", ");

      const items: TaskDigestItem[] = [...overdue, ...onDay].slice(0, MAX_ROWS).map((t) => ({
        leadName: t.lead?.name ?? TASK_TYPE_LABEL[t.type] ?? "Task",
        kind: TASK_TYPE_LABEL[t.type] ?? t.type,
        when: t.dueDate < dayDate ? `Overdue since ${t.dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : (t.dueTime ?? ""),
        company: t.lead?.company ?? null,
        overdue: t.dueDate < dayDate,
      }));

      await sendTaskDigestEmail(
        user.email,
        taskDigestEmail({
          firstName: user.name.trim().split(/\s+/)[0] || null,
          isToday,
          dayLabel: dayDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }),
          summary,
          overdueCount: overdue.length,
          items,
          moreCount: Math.max(0, tasks.length - MAX_ROWS),
          todayUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard`,
        }),
      );
      await prisma.user.update({ where: { id: user.id }, data: { taskDigestSentOn: day } });
      sent++;
    } catch (err) {
      console.error(`Failed to send task digest to user ${user.id}`, err);
    }
  }
  return { checked: users.length, sent };
}
