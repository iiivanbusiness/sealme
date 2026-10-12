import Link from "next/link";
import { prisma } from "@/lib/db";
import { parseFee } from "@/lib/money";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { dayInZone, startOfDayInZone } from "@/lib/viewer-time";
import { formatPhone } from "@/lib/phone";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { TASK_PRIORITY_CHIP, TASK_PRIORITY_LABEL, TASK_TYPE_LABEL } from "@/lib/tasks";
import { CALL_OUTCOME_CHIP, CALL_OUTCOME_LABEL } from "@/lib/call-outcomes";
import { clockIn, planDay, type TodoTask } from "@/lib/todo";
import TodoList, { type TodoRow, type TodoView } from "@/components/dashboard/TodoList";
import { createTodo, quickAssignLeads, searchTodoLeads, setTaskStatus } from "@/app/(app)/leads/task-actions";
import { startLeadCall } from "@/app/(app)/leads/phone-actions";
import { setTaskDigestEmail } from "@/app/(app)/preferences-actions";

const DAY = 24 * 60 * 60 * 1000;
// What an opened group (late, done, a day) lists at most; the rest is a count.
const LIST_CAP = 50;
const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const money = (v: number) => (v >= 10_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v).toLocaleString("en-US")}`);
const versus = (now: number, before: number, what: string) =>
  now === before ? `Same as ${what}` : `${now > before ? "+" : "−"}${n(Math.abs(now - before))} vs ${what}`;

const taskSelect = {
  id: true,
  type: true,
  status: true,
  dueDate: true,
  dueTime: true,
  priority: true,
  note: true,
  completedAt: true,
  createdAt: true,
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  lead: { select: { id: true, name: true, company: true, campaign: true, phone: true } },
} as const;

type Me = { id: string; name: string; phoneVerifiedAt: Date | null; taskDigestEmail: boolean };

// The top of a prospecting Dashboard: the day in one sentence, four
// numbers, a to-do list that stays short however much there is, and the
// week's calls.
//   view  "me", "team", or a teammate's id; whoever hands out work starts on
//         the team, everyone else only has their own
//   queue working through one's own cold calls, one after another
// In the iPhone app (phone), the two contract numbers make way for notes
// and new leads.
export async function todaySection(o: { workspaceId: string; me: Me; tz: string; view: string | undefined; queue: boolean; canAssign: boolean; phoneInGuide: boolean; phone?: boolean }) {
  const { workspaceId, me, tz, canAssign } = o;
  const now = new Date();
  const today = dayInZone(now, tz);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const tomorrowDate = new Date(todayDate.getTime() + DAY);
  const horizon = new Date(todayDate.getTime() + 8 * DAY);
  const dayStart = startOfDayInZone(now, tz);
  const yesterdayStart = new Date(dayStart.getTime() - DAY);
  const weekday = (todayDate.getUTCDay() + 6) % 7; // weeks start on Monday
  const weekStart = new Date(dayStart.getTime() - weekday * DAY);
  const lastWeekStart = new Date(weekStart.getTime() - 7 * DAY);
  const monthStart = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  const weekEnd = new Date(todayDate.getTime() + (7 - weekday) * DAY);

  const members = await prisma.user.findMany({ where: { workspaceId, deactivatedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const person = canAssign && o.view && o.view !== "me" && o.view !== "team" ? members.find((m) => m.id === o.view) : undefined;
  const team = canAssign && !person && o.view !== "me";
  const subject = team ? null : (person ?? { id: me.id, name: me.name });
  const isMe = subject?.id === me.id;
  const queueMode = isMe && o.queue;

  // Whose numbers: the team's on the team view, otherwise the person's.
  const calledBy = subject ? { userId: subject.id } : {};
  const bookedBy = subject ? { OR: [{ createdById: subject.id }, { createdById: null, assigneeId: subject.id }] } : {};
  const { where: dealVisibility } = await dealVisibilityFilter();

  const [callsToday, callsYesterday, meetingsThisWeek, meetingsLastWeek, signed, weekCalls, approvals, myDeals, callsToCheck, freeLeads] = await Promise.all([
    prisma.phoneCall.count({ where: { workspaceId, ...calledBy, startedAt: { gte: dayStart }, status: { in: ["processed", "skipped"] } } }),
    prisma.phoneCall.count({ where: { workspaceId, ...calledBy, startedAt: { gte: yesterdayStart, lt: dayStart }, status: { in: ["processed", "skipped"] } } }),
    prisma.task.count({ where: { workspaceId, ...bookedBy, type: "sales_call", createdAt: { gte: weekStart } } }),
    prisma.task.count({ where: { workspaceId, ...bookedBy, type: "sales_call", createdAt: { gte: lastWeekStart, lt: weekStart } } }),
    prisma.contract.findMany({ where: { signedAt: { gte: monthStart }, deal: { workspaceId, trashedAt: null, ...dealVisibility } }, select: { deal: { select: { feeDisplay: true } } } }),
    prisma.phoneCall.findMany({ where: { workspaceId, ...calledBy, startedAt: { gte: weekStart }, status: { in: ["processed", "skipped"] } }, select: { startedAt: true, outcome: true }, take: 20000 }),
    // What's waiting on the viewer, whichever list they're looking at.
    prisma.reviewStep.findMany({
      where: { status: "pending", assigneeId: me.id, contract: { deal: { workspaceId, trashedAt: null } } },
      select: { id: true, contract: { select: { reviewSteps: { where: { status: "pending" }, orderBy: { order: "asc" }, take: 1, select: { id: true } }, deal: { select: { id: true, service: true, client: { select: { name: true } } } } } } },
      take: 20,
    }),
    prisma.deal.count({ where: { workspaceId, ownerId: me.id, trashedAt: null, status: { in: ["ready", "missing_info", "changes_requested"] } } }),
    prisma.phoneCall.count({ where: { workspaceId, userId: me.id, status: { in: ["pending", "failed"] } } }),
    canAssign ? prisma.lead.count({ where: { workspaceId, ownerId: null, stage: { notIn: ["converted", "lost"] }, tasks: { none: { status: "open" } } } }) : 0,
  ]);
  const myApprovals = approvals.filter((s) => s.contract.reviewSteps[0]?.id === s.id).map((s) => s.contract.deal);
  const ledBy = subject ? { ownerId: subject.id } : {};
  const [notesThisWeek, notesLastWeek, leadsThisWeek, leadsLastWeek] = o.phone
    ? await Promise.all([
        prisma.phoneCall.count({ where: { workspaceId, ...calledBy, status: "processed", notes: { not: null }, processedAt: { gte: weekStart } } }),
        prisma.phoneCall.count({ where: { workspaceId, ...calledBy, status: "processed", notes: { not: null }, processedAt: { gte: lastWeekStart, lt: weekStart } } }),
        prisma.lead.count({ where: { workspaceId, ...ledBy, createdAt: { gte: weekStart } } }),
        prisma.lead.count({ where: { workspaceId, ...ledBy, createdAt: { gte: lastWeekStart, lt: weekStart } } }),
      ])
    : [0, 0, 0, 0];

  // How a to-do reads.
  const who = (p: { id: string; name: string } | null) => (p ? (p.id === me.id ? "you" : firstName(p.name)) : "nobody");
  const from = (t: TodoTask) => (t.createdBy && t.assignee && t.createdBy.id !== t.assignee.id ? `from ${who(t.createdBy)}` : null);
  const title = (t: TodoTask) => {
    const done = t.status === "done";
    if (!t.lead) return t.note ?? TASK_TYPE_LABEL[t.type] ?? "To-do";
    if (t.type === "cold_call") return `${done ? "Called" : "Call"} ${t.lead.name}`;
    if (t.type === "sales_call") return `${done ? "Sales call with" : "Sales call:"} ${t.lead.name}`;
    if (t.type === "follow_up") return `${done ? "Followed up with" : "Follow up with"} ${t.lead.name}`;
    return `${TASK_TYPE_LABEL[t.type] ?? "To-do"}: ${t.lead.name}`;
  };
  const shortDay = (d: Date) => (d.getTime() === todayDate.getTime() - DAY ? "Yesterday" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
  const nowClock = clockIn(now, tz);
  const row = (t: TodoTask, opts: { time?: string | null; outcome?: string | null } = {}): TodoRow => {
    const finished = t.status !== "open";
    const late = !finished && (t.dueDate < todayDate || (t.dueDate.getTime() === todayDate.getTime() && Boolean(t.dueTime) && t.dueTime! < nowClock));
    const outcome = opts.outcome ? { label: CALL_OUTCOME_LABEL[opts.outcome] ?? opts.outcome, cls: CALL_OUTCOME_CHIP[opts.outcome] ?? "chip-neutral" } : null;
    const priority = !finished && TASK_PRIORITY_CHIP[t.priority] ? { label: TASK_PRIORITY_LABEL[t.priority], cls: TASK_PRIORITY_CHIP[t.priority]! } : null;
    return {
      key: `t-${t.id}`,
      time: opts.time !== undefined ? opts.time : t.dueDate < todayDate ? `${shortDay(t.dueDate)}${t.dueTime ? ` ${t.dueTime}` : ""}` : t.dueTime,
      late,
      title: title(t),
      href: t.lead ? `/leads/${t.lead.id}` : null,
      detail: [t.lead?.campaign ? `For ${t.lead.campaign}` : null, t.lead?.company, t.lead ? t.note : null, from(t)].filter(Boolean).join(" · "),
      status: finished ? (t.status as "done" | "skipped") : "open",
      chip: finished ? (outcome ?? { label: t.status === "done" ? "Done" : "Skipped", cls: t.status === "done" ? "chip-success" : "chip-neutral" }) : priority,
      taskId: t.id,
      call: !finished && isMe && t.lead?.phone && t.type !== "other" ? { leadId: t.lead.id, leadName: t.lead.name, phone: formatPhone(t.lead.phone) } : null,
      icon: "task",
    };
  };

  let view: TodoView;
  let mine = { left: 0, late: 0, meetings: 0 };

  if (subject) {
    const [open, doneTasks, doneCount, calls, upcomingCounts, upcomingTasks, events] = await Promise.all([
      prisma.task.findMany({ where: { workspaceId, assigneeId: subject.id, status: "open", dueDate: { lt: tomorrowDate } }, select: taskSelect, take: 5000 }),
      prisma.task.findMany({ where: { workspaceId, assigneeId: subject.id, status: { in: ["done", "skipped"] }, completedAt: { gte: dayStart } }, select: taskSelect, orderBy: { completedAt: "desc" }, take: LIST_CAP }),
      prisma.task.count({ where: { workspaceId, assigneeId: subject.id, status: { in: ["done", "skipped"] }, completedAt: { gte: dayStart } } }),
      prisma.phoneCall.findMany({
        where: { workspaceId, userId: subject.id, startedAt: { gte: dayStart }, status: { in: ["processed", "skipped"] }, leadId: { not: null } },
        select: { id: true, mode: true, outcome: true, startedAt: true, dealId: true, lead: { select: { id: true, name: true, company: true } } },
        orderBy: { startedAt: "desc" },
        take: 300,
      }),
      prisma.task.groupBy({ by: ["dueDate"], where: { workspaceId, assigneeId: subject.id, status: "open", dueDate: { gte: tomorrowDate, lt: horizon } }, _count: { _all: true } }),
      prisma.task.findMany({ where: { workspaceId, assigneeId: subject.id, status: "open", dueDate: { gte: tomorrowDate, lt: horizon } }, select: taskSelect, orderBy: [{ dueDate: "asc" }, { dueTime: "asc" }], take: 300 }),
      // The workspace calendar is the managers' to read; reps get their
      // meetings as sales call to-dos.
      isMe && canAssign
        ? prisma.calendarEvent.findMany({ where: { workspaceId, startTime: { gte: dayStart, lt: new Date(dayStart.getTime() + 8 * DAY) } }, select: { id: true, title: true, clientName: true, startTime: true, platform: true, meetingUrl: true }, orderBy: { startTime: "asc" } })
        : [],
    ]);

    const plan = planDay({ open, now, today, tz, queueMode });
    // A meeting that's also a sales call to-do shows once, as the to-do.
    const allTasks = [...open, ...upcomingTasks];
    const isTodo = (e: (typeof events)[number]) =>
      allTasks.some((t) => t.type === "sales_call" && t.lead && e.clientName === t.lead.name && t.dueDate.toISOString().slice(0, 10) === dayInZone(e.startTime, tz) && t.dueTime === clockIn(e.startTime, tz));
    const eventRow = (e: (typeof events)[number]): TodoRow => ({
      key: `e-${e.id}`,
      time: clockIn(e.startTime, tz),
      late: false,
      title: e.title,
      href: e.meetingUrl ?? "/calendar",
      detail: e.platform === "meet" ? "Google Meet" : "Zoom",
      status: "open",
      chip: null,
      taskId: null,
      call: null,
      icon: "event",
    });
    const scheduled = [
      ...plan.scheduled.map((t) => row(t)),
      ...events.filter((e) => dayInZone(e.startTime, tz) === today && e.startTime > now && !isTodo(e)).map(eventRow),
    ].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

    // Contracts and calls that need the viewer go with their other to-dos.
    const waiting: TodoRow[] = isMe
      ? [
          ...myApprovals.slice(0, 3).map((d) => ({ key: `a-${d.id}`, time: null, late: false, title: `Approve the contract for ${d.client.name}`, href: `/deals/${d.id}/contract`, detail: d.service, status: "open" as const, chip: { label: "Approval", cls: "chip-warn" }, taskId: null, call: null, icon: "info" as const })),
          ...(myDeals ? [{ key: "deals", time: null, late: false, title: `Finish ${plural(myDeals, "contract", "contracts")}`, href: "/deals", detail: "Fill in what's missing, review and send", status: "open" as const, chip: null, taskId: null, call: null, icon: "info" as const }] : []),
          ...(callsToCheck ? [{ key: "check", time: null, late: false, title: `Check ${plural(callsToCheck, "call", "calls")}`, href: "/calls", detail: "Pick who it was with, or try again", status: "open" as const, chip: null, taskId: null, call: null, icon: "info" as const }] : []),
        ]
      : [];

    // Done today: the to-dos, with how each call went, and calls made
    // without one.
    const sameWork = (t: TodoTask, c: (typeof calls)[number]) => Boolean(t.lead && c.lead && t.lead.id === c.lead.id);
    const extraCalls = calls.filter((c) => !doneTasks.some((t) => sameWork(t, c)));
    const doneRows: TodoRow[] = [
      ...doneTasks.map((t) => row(t, { time: t.completedAt ? clockIn(t.completedAt, tz) : null, outcome: calls.find((c) => sameWork(t, c))?.outcome ?? null })),
      ...extraCalls.slice(0, LIST_CAP).map((c) => ({
        key: `c-${c.id}`,
        time: clockIn(c.startedAt, tz),
        late: false,
        title: `Called ${c.lead?.name ?? "a lead"}`,
        href: c.mode === "sales" && c.dealId ? `/deals/${c.dealId}` : c.lead ? `/leads/${c.lead.id}` : "/calls",
        detail: c.lead?.company ?? "",
        status: "done" as const,
        chip: c.mode === "sales" ? { label: "Deal created", cls: "chip-success" } : c.outcome ? { label: CALL_OUTCOME_LABEL[c.outcome] ?? c.outcome, cls: CALL_OUTCOME_CHIP[c.outcome] ?? "chip-neutral" } : null,
        taskId: null,
        call: null,
        icon: "call" as const,
      })),
    ].sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));

    // The next week, one chip per day, opened on demand.
    const countByDay = new Map(upcomingCounts.map((g) => [g.dueDate.toISOString().slice(0, 10), g._count._all]));
    const itemsByDay = new Map<string, { time: string; title: string }[]>();
    for (const t of upcomingTasks) {
      const key = t.dueDate.toISOString().slice(0, 10);
      itemsByDay.set(key, [...(itemsByDay.get(key) ?? []), { time: t.dueTime ?? "", title: title(t) }]);
    }
    for (const e of events) {
      const key = dayInZone(e.startTime, tz);
      if (key <= today || isTodo(e)) continue;
      itemsByDay.set(key, [...(itemsByDay.get(key) ?? []), { time: clockIn(e.startTime, tz), title: e.title }]);
      countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
    }
    const days = [...countByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({
        key,
        label: key === tomorrowDate.toISOString().slice(0, 10) ? "Tomorrow" : `${new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${Number(key.slice(8))}`,
        count,
        items: (itemsByDay.get(key) ?? []).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")).slice(0, 20),
      }));

    const nextIsQueued = Boolean(plan.next && plan.next.type === "cold_call" && !plan.next.dueTime && plan.next.dueDate.getTime() === todayDate.getTime());
    view = {
      kind: "list",
      subject: { id: subject.id, name: subject.name, isMe },
      progress: { done: doneCount, total: doneCount + open.length },
      next: plan.next ? row(plan.next) : null,
      queueMode,
      scheduled,
      queue: { left: plan.queue.length + (nextIsQueued ? 1 : 0), names: plan.queue.slice(0, 2).map((t) => t.lead?.name ?? "") },
      other: [...plan.other.map((t) => row(t)), ...waiting],
      late: { count: plan.late.length, rows: plan.late.slice(0, LIST_CAP).map((t) => row(t)) },
      done: { count: doneCount + extraCalls.length, rows: doneRows.slice(0, LIST_CAP) },
      days,
    };
    if (isMe) {
      const lateCount = open.filter((t) => t.dueDate < todayDate).length;
      mine = { left: open.length - lateCount, late: lateCount, meetings: allTasks.filter((t) => t.type === "sales_call" && t.dueDate >= todayDate && t.dueDate < weekEnd).length };
    }
  } else {
    // The team: one line per person, never one per to-do.
    const [openToday, late, doneToday, nexts] = await Promise.all([
      prisma.task.groupBy({ by: ["assigneeId"], where: { workspaceId, status: "open", dueDate: todayDate }, _count: { _all: true } }),
      prisma.task.groupBy({ by: ["assigneeId"], where: { workspaceId, status: "open", dueDate: { lt: todayDate } }, _count: { _all: true } }),
      prisma.task.groupBy({ by: ["assigneeId"], where: { workspaceId, status: { in: ["done", "skipped"] }, completedAt: { gte: dayStart } }, _count: { _all: true } }),
      Promise.all(
        members.map((m) =>
          prisma.task.findFirst({
            where: { workspaceId, assigneeId: m.id, status: "open", dueDate: todayDate },
            select: taskSelect,
            orderBy: [{ dueTime: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
          }),
        ),
      ),
    ]);
    const count = (rows: { assigneeId: string | null; _count: { _all: number } }[], id: string) => rows.find((r) => r.assigneeId === id)?._count._all ?? 0;
    const people = members
      .map((m, i) => {
        const done = count(doneToday, m.id);
        const left = count(openToday, m.id);
        const next = nexts[i];
        return { id: m.id, name: m.id === me.id ? "You" : m.name, done, total: done + left, late: count(late, m.id), next: next ? `${next.dueTime ? `${next.dueTime} ` : ""}${title(next)}` : null };
      })
      .filter((p) => p.total > 0 || p.late > 0 || p.id !== me.id)
      .sort((a, b) => b.late - a.late || b.total - a.total || a.name.localeCompare(b.name));
    const totals = people.reduce((s, p) => ({ done: s.done + p.done, total: s.total + p.total }), { done: 0, total: 0 });
    view = { kind: "team", people, progress: totals };
  }

  // Looking at the team or a teammate, the sentence is still the viewer's.
  if (!isMe) {
    const [myOpen, myMeetings] = await Promise.all([
      prisma.task.groupBy({ by: ["dueDate"], where: { workspaceId, assigneeId: me.id, status: "open", dueDate: { lt: tomorrowDate } }, _count: { _all: true } }),
      prisma.task.count({ where: { workspaceId, assigneeId: me.id, status: "open", type: "sales_call", dueDate: { gte: todayDate, lt: weekEnd } } }),
    ]);
    const sum = (rows: typeof myOpen) => rows.reduce((s, g) => s + g._count._all, 0);
    mine = { left: sum(myOpen.filter((g) => g.dueDate.getTime() === todayDate.getTime())), late: sum(myOpen.filter((g) => g.dueDate < todayDate)), meetings: myMeetings };
  }

  // The day in one sentence, always the viewer's own.
  const sentence = [
    mine.left > 0 ? `${plural(mine.left, "to-do", "to-dos")} left today` : "Nothing left today",
    mine.late > 0 ? `${n(mine.late)} late` : null,
    mine.meetings > 0 ? `${plural(mine.meetings, "meeting", "meetings")} this week` : null,
  ].filter(Boolean) as string[];

  const signedValue = signed.reduce((s, c) => s + parseFee(c.deal.feeDisplay), 0);
  const waitingCount = myApprovals.length + myDeals + callsToCheck;
  const whose = team ? "Team calls" : person && !isMe ? `${firstName(person.name)}'s calls` : "Calls";
  const stats = [
    { label: `${whose} today`, value: n(callsToday), sub: versus(callsToday, callsYesterday, "yesterday") },
    { label: "Meetings booked this week", value: n(meetingsThisWeek), sub: versus(meetingsThisWeek, meetingsLastWeek, "last week") },
    ...(o.phone
      ? [
          { label: "Notes this week", value: n(notesThisWeek), sub: versus(notesThisWeek, notesLastWeek, "last week") },
          { label: "New leads this week", value: n(leadsThisWeek), sub: versus(leadsThisWeek, leadsLastWeek, "last week") },
        ]
      : [
          {
            label: "Waiting on you",
            value: n(waitingCount),
            sub: [myApprovals.length && plural(myApprovals.length, "approval", "approvals"), myDeals && plural(myDeals, "contract", "contracts"), callsToCheck && plural(callsToCheck, "call", "calls")].filter(Boolean).join(" · ") || "Nothing right now",
          },
          { label: "Signed this month", value: money(signedValue), sub: plural(signed.length, "contract", "contracts") },
        ]),
  ];

  // Calls per weekday this week; the weekend only when someone called.
  const perDay = Array.from({ length: 7 }, (_, i) => {
    const day = dayInZone(new Date(weekStart.getTime() + i * DAY + 12 * 60 * 60 * 1000), tz);
    const these = weekCalls.filter((c) => dayInZone(c.startedAt, tz) === day);
    return { day, label: new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), calls: these.length, meetings: these.filter((c) => c.outcome === "meeting_booked").length };
  }).filter((d, i) => i < 5 || d.calls > 0);
  const maxCalls = Math.max(1, ...perDay.map((d) => d.calls));

  const phoneNotice = isTelnyxConfigured() && !me.phoneVerifiedAt && !o.phoneInGuide;

  return {
    sentence: sentence.join(", "),
    block: (
      <div className="mb-8 flex flex-col gap-4">
        {phoneNotice && (
          <Link href="/settings#phone" className="card row-hover flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: "var(--tone-due)" }} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium" style={{ color: "var(--ink)" }}>Add your phone number</div>
              <div className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>One time, takes a minute. Then a tap on Call rings you and connects your client.</div>
            </div>
            <span aria-hidden style={{ color: "var(--ink-muted)" }}>›</span>
          </Link>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="glass-card glass-card-solid flex flex-col gap-1 p-4 sm:p-5">
              <div className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{s.label}</div>
              <div className="font-mono-tab text-[26px] font-medium leading-tight" style={{ letterSpacing: "-0.5px" }}>{s.value}</div>
              <div className="truncate text-[12px]" style={{ color: "var(--ink-muted)" }} title={s.sub}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <TodoList
            view={view}
            canAssign={canAssign}
            members={members.map((m) => ({ id: m.id, name: m.id === me.id ? `${m.name} (you)` : m.name }))}
            meId={me.id}
            freeLeads={freeLeads}
            digestEnabled={me.taskDigestEmail}
            statusAction={setTaskStatus}
            callAction={startLeadCall}
            createAction={createTodo}
            searchAction={searchTodoLeads}
            assignAction={quickAssignLeads}
            digestAction={setTaskDigestEmail}
          />

          <section className="glass-card glass-card-solid h-fit p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[15px] font-medium">{team ? "Team calls this week" : person && !isMe ? `${firstName(person.name)}'s calls this week` : "Your calls this week"}</h2>
              <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{plural(weekCalls.length, "call", "calls")}</span>
            </div>
            <div className="flex h-[120px] items-end gap-2">
              {perDay.map((d) => {
                const future = d.day > today;
                const isToday = d.day === today;
                return (
                  <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--ink-muted)" }}>{future ? "" : d.calls}</span>
                    <div
                      className="w-full rounded-[6px]"
                      title={`${d.label}: ${plural(d.calls, "call", "calls")}, ${plural(d.meetings, "meeting", "meetings")}`}
                      style={future ? { height: 8, border: "1px dashed var(--hairline)" } : { height: `${Math.max(6, Math.round((d.calls / maxCalls) * 76))}px`, background: isToday ? "var(--ink)" : "var(--hairline)" }}
                    />
                    <span className="text-[11.5px]" style={{ color: isToday ? "var(--ink)" : "var(--ink-muted)", fontWeight: isToday ? 500 : undefined }}>{d.label}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
              {plural(perDay.reduce((s, d) => s + d.meetings, 0), "meeting", "meetings")} booked from calls this week
            </div>
          </section>
        </div>
      </div>
    ),
  };
}
