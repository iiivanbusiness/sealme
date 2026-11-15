"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { isValidDay, isValidTime, isValidTimeZone, TASK_PRIORITIES, TASK_TYPES } from "@/lib/tasks";
import { dayInZone } from "@/lib/viewer-time";
import { currentUserWithRole } from "@/lib/permissions";
import { notifyTasksAssigned } from "@/lib/task-notify";
import { dispatchLeadsUpdated, dispatchMeetingsBooked, dispatchTasksCompleted } from "@/lib/webhook-events";

export type TaskInput = {
  assigneeId: string;
  type: string;
  dueDate: string; // YYYY-MM-DD
  dueTime: string; // HH:mm or ""
  timezone: string;
  priority: string;
  note: string;
};

function clean(input: TaskInput) {
  if (!(TASK_TYPES as readonly string[]).includes(input.type)) throw new Error("Pick what kind of task this is");
  if (!isValidDay(input.dueDate)) throw new Error("Pick a day");
  if (input.dueTime && !isValidTime(input.dueTime)) throw new Error("That time doesn't look right");
  const priority = (TASK_PRIORITIES as readonly string[]).includes(input.priority) ? input.priority : "normal";
  return {
    type: input.type,
    dueDate: new Date(`${input.dueDate}T00:00:00Z`),
    dueTime: input.dueTime || null,
    timezone: isValidTimeZone(input.timezone) ? input.timezone : "UTC",
    priority,
    note: input.note.trim().slice(0, 1000) || null,
  };
}

// A sales call put on someone's day by hand is a booked meeting.
function bookedByHand(leadId: string, taskId: string, repId: string, task: ReturnType<typeof clean>) {
  return { leadId, taskId, repId, date: task.dueDate.toISOString().slice(0, 10), time: task.dueTime, timeZone: task.timezone, source: "manual" as const };
}

async function activeMember(workspaceId: string, userId: string): Promise<string | null> {
  const u = await prisma.user.findFirst({ where: { id: userId, workspaceId, deactivatedAt: null }, select: { id: true } });
  return u?.id ?? null;
}

// Bulk "Assign" from the lead list: one task per lead for one rep, and by
// default the rep becomes the lead's owner. Managers only.
export async function assignLeadTasks(input: TaskInput & { leadIds: string[]; makeOwner: boolean }): Promise<{ created: number }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  if (!access.canAssign) throw new Error("Only managers can assign tasks to others");
  if (!Array.isArray(input.leadIds) || input.leadIds.length === 0) throw new Error("Pick at least one lead");
  if (input.leadIds.length > 1000) throw new Error("Assign up to 1,000 leads at a time");

  const task = clean(input);
  const assigneeId = await activeMember(workspace.id, input.assigneeId);
  if (!assigneeId) throw new Error("Pick who it's for");

  const leads = await prisma.lead.findMany({
    where: { workspaceId: workspace.id, id: { in: input.leadIds }, AND: [access.where] },
    select: { id: true, ownerId: true },
  });
  const ids = leads.map((l) => l.id);
  if (ids.length === 0) throw new Error("None of those leads are available");

  const created = await prisma.$transaction(async (tx) => {
    const rows = await tx.task.createManyAndReturn({
      data: ids.map((leadId) => ({ workspaceId: workspace.id, leadId, assigneeId, createdById: access.userId, ...task })),
      select: { id: true, leadId: true },
    });
    if (input.makeOwner) await tx.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId: assigneeId } });
    return rows;
  });

  if (input.makeOwner) {
    await dispatchLeadsUpdated(workspace.id, leads.filter((l) => l.ownerId !== assigneeId).map((l) => ({ leadId: l.id, changed: ["owner"], previousStage: null })));
  }
  if (task.type === "sales_call") await dispatchMeetingsBooked(workspace.id, created.map((t) => bookedByHand(t.leadId!, t.id, assigneeId, task)));

  if (assigneeId !== access.userId) {
    const actor = await currentUserWithRole();
    const lead = ids.length === 1 ? await prisma.lead.findUnique({ where: { id: ids[0] }, select: { id: true, name: true } }) : null;
    await notifyTasksAssigned({ workspaceId: workspace.id, assigneeId, actorName: actor.name, count: ids.length, type: task.type, dueDate: task.dueDate, dueTime: task.dueTime, lead: lead ?? undefined });
  }

  revalidatePath("/leads");
  return { created: ids.length };
}

// One task on a lead (a to-do from the Dashboard). A rep can only give
// tasks to themselves. Not exported: createTodo is the way in.
async function createLeadTask(leadId: string, input: TaskInput): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, AND: [access.where] }, select: { id: true, name: true } });
  if (!lead) throw new Error("Lead not found");

  const task = clean(input);
  const assigneeId = access.canAssign ? await activeMember(workspace.id, input.assigneeId) : access.userId;
  if (!assigneeId) throw new Error("Pick who it's for");

  const created = await prisma.task.create({ data: { workspaceId: workspace.id, leadId, assigneeId, createdById: access.userId, ...task }, select: { id: true } });
  if (task.type === "sales_call") await dispatchMeetingsBooked(workspace.id, [bookedByHand(leadId, created.id, assigneeId, task)]);
  if (assigneeId !== access.userId) {
    const actor = await currentUserWithRole();
    await notifyTasksAssigned({ workspaceId: workspace.id, assigneeId, actorName: actor.name, count: 1, type: task.type, dueDate: task.dueDate, dueTime: task.dueTime, lead });
  }
  revalidatePath(`/leads/${leadId}`);
}

// "+ Add to-do" on the Dashboard: a task on a lead, or (for an Other
// to-do) on its own, with the note saying what to do.
export async function createTodo(input: TaskInput & { leadId: string | null }): Promise<void> {
  if (input.leadId) {
    await createLeadTask(input.leadId, input);
  } else {
    const workspace = await requireProspecting();
    const access = await leadAccess();
    if (input.type !== "other") throw new Error("Pick a lead, or make it an Other to-do");
    const task = clean(input);
    if (!task.note) throw new Error("Write what needs doing");
    const assigneeId = access.canAssign ? await activeMember(workspace.id, input.assigneeId) : access.userId;
    if (!assigneeId) throw new Error("Pick who it's for");
    await prisma.task.create({ data: { workspaceId: workspace.id, assigneeId, createdById: access.userId, ...task } });
    if (assigneeId !== access.userId) {
      const actor = await currentUserWithRole();
      await notifyTasksAssigned({ workspaceId: workspace.id, assigneeId, actorName: actor.name, count: 1, type: task.type, dueDate: task.dueDate, dueTime: task.dueTime });
    }
  }
  revalidatePath("/dashboard");
}

// The lead picker in "+ Add to-do": leads this person can see, by name or
// company.
export async function searchTodoLeads(q: string): Promise<{ id: string; name: string; company: string | null }[]> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const term = typeof q === "string" ? q.trim().slice(0, 100) : "";
  if (term.length < 2) return [];
  return prisma.lead.findMany({
    where: {
      workspaceId: workspace.id,
      AND: [access.where, { OR: [{ name: { contains: term, mode: "insensitive" } }, { company: { contains: term, mode: "insensitive" } }] }],
      stage: { notIn: ["converted", "lost"] },
    },
    select: { id: true, name: true, company: true },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
}

// Done, skipped, or back to open. The assignee can do this, and so can a
// manager (for a rep who's out, or a task that no longer applies).
export async function setTaskStatus(taskId: string, status: "open" | "done" | "skipped"): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  if (!["open", "done", "skipped"].includes(status)) throw new Error("Unknown status");
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId: workspace.id }, select: { id: true, assigneeId: true, leadId: true, status: true } });
  if (!task || (!access.canAssign && task.assigneeId !== access.userId)) throw new Error("Task not found");

  await prisma.task.update({ where: { id: task.id }, data: { status, completedAt: status === "open" ? null : new Date() } });
  if (status !== "open" && task.status === "open") await dispatchTasksCompleted(workspace.id, [task.id], { userId: access.userId });
  if (task.leadId) revalidatePath(`/leads/${task.leadId}`);
  revalidatePath("/dashboard");
}

// "Hand out work" on the Dashboard: the next leads nobody is working on
// (no owner, no open task, not converted or lost), oldest first, become
// cold calls for one rep on one day, and the rep becomes their owner.
export async function quickAssignLeads(input: { assigneeId: string; count: number; day: "today" | "tomorrow"; timezone: string }): Promise<{ created: number }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  if (!access.canAssign) throw new Error("Only managers can hand out work");
  const count = Math.min(Math.max(Math.round(Number(input.count) || 0), 1), 200);
  const tz = isValidTimeZone(input.timezone) ? input.timezone : "UTC";
  const today = dayInZone(new Date(), tz);
  const dueDate = input.day === "tomorrow" ? new Date(new Date(`${today}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : today;

  const free = await prisma.lead.findMany({
    where: { workspaceId: workspace.id, ownerId: null, stage: { notIn: ["converted", "lost"] }, isClient: false, deals: { none: { trashedAt: null } }, tasks: { none: { status: "open" } } },
    orderBy: { createdAt: "asc" },
    take: count,
    select: { id: true },
  });
  if (free.length === 0) throw new Error("No free leads left. Import more, or add some by hand");

  const result = await assignLeadTasks({ assigneeId: input.assigneeId, type: "cold_call", dueDate, dueTime: "", timezone: tz, priority: "normal", note: "", leadIds: free.map((l) => l.id), makeOwner: true });
  revalidatePath("/dashboard");
  return result;
}
