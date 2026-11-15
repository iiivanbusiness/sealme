"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import LeadCallButton from "@/components/LeadCallButton";
import QuickAssign from "@/components/QuickAssign";
import TaskDigestToggle from "@/components/TaskDigestToggle";
import TaskFields, { todayLocal, viewerTimeZone, type TaskDraft } from "@/components/TaskFields";
import type { CallPlan } from "@/app/(app)/leads/phone-actions";

export type TodoRow = {
  key: string;
  time: string | null;
  late: boolean;
  title: string;
  href: string | null;
  detail: string;
  status: "open" | "done" | "skipped";
  chip: { label: string; cls: string } | null;
  taskId: string | null;
  call: { leadId: string; leadName: string; phone: string | null } | null;
  icon: "task" | "call" | "event" | "info";
};

type Day = { key: string; label: string; count: number; items: { time: string; title: string }[] };
type Person = { id: string; name: string; done: number; total: number; late: number; next: string | null };

export type TodoView =
  | {
      kind: "list";
      subject: { id: string; name: string; isMe: boolean };
      progress: { done: number; total: number };
      next: TodoRow | null;
      queueMode: boolean;
      scheduled: TodoRow[];
      queue: { left: number; names: string[] };
      other: TodoRow[];
      late: { count: number; rows: TodoRow[] };
      done: { count: number; rows: TodoRow[] };
      days: Day[];
    }
  | { kind: "team"; people: Person[]; progress: { done: number; total: number } };

type Member = { id: string; name: string };
type StatusAction = (taskId: string, status: "open" | "done" | "skipped") => Promise<void>;
type CallAction = (leadId: string, input?: { mode?: string }) => Promise<CallPlan>;

// How much of a group shows before "Show N more".
const SCHEDULED_SHOWN = 5;
const OTHER_SHOWN = 3;

// The to-do list on the Dashboard (Reminders, under Needs you). However
// many to-dos there are, it stays a screen long: the next thing, what's set
// for a time, the cold calls as one queue, a few other to-dos, and chips
// that open late, done and the coming days on demand. The team view is one
// line a person.
export default function TodoList({
  title = "To-do",
  view,
  canAssign,
  members,
  meId,
  freeLeads,
  digestEnabled,
  statusAction,
  callAction,
  createAction,
  searchAction,
  assignAction,
  digestAction,
}: {
  title?: string;
  view: TodoView;
  canAssign: boolean;
  members: Member[];
  meId: string;
  freeLeads: number;
  digestEnabled: boolean;
  statusAction: StatusAction;
  callAction: CallAction;
  createAction: (input: TaskDraft & { timezone: string; leadId: string | null }) => Promise<void>;
  searchAction: (q: string) => Promise<{ id: string; name: string; company: string | null }[]>;
  assignAction: (input: { assigneeId: string; count: number; day: "today" | "tomorrow"; timezone: string }) => Promise<{ created: number }>;
  digestAction: (enabled: boolean) => Promise<void>;
}) {
  const [panel, setPanel] = useState<"add" | "handout" | null>(null);
  const toggle = (p: "add" | "handout") => setPanel(panel === p ? null : p);
  const isTeam = view.kind === "team";
  const other = view.kind === "list" && !view.subject.isMe ? view.subject : null;
  const pct = view.progress.total ? Math.round((view.progress.done / view.progress.total) * 100) : 0;

  return (
    <section className="glass-card glass-card-solid flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {other ? (
            <>
              <Link href="/dashboard?todo=team" scroll={false} className="text-[13px] font-medium" style={{ color: "var(--accent-blue)" }}>
                ← Team
              </Link>
              <h2 className="truncate text-[15px] font-medium">{other.name}</h2>
            </>
          ) : (
            <h2 className="text-[15px] font-medium">{title}</h2>
          )}
          {canAssign && !other && (
            <div className="flex rounded-full p-[3px] text-[12.5px]" style={{ background: "var(--surface-2)" }} role="tablist" aria-label="Whose to-dos">
              {(["me", "team"] as const).map((s) => {
                const on = (s === "team") === isTeam;
                return (
                  <Link
                    key={s}
                    href={`/dashboard?todo=${s}`}
                    scroll={false}
                    role="tab"
                    aria-selected={on}
                    className="rounded-full px-3 py-1 font-medium"
                    style={on ? { background: "var(--surface-1)", color: "var(--ink)", boxShadow: "0 0 0 1px var(--hairline)" } : { color: "var(--ink-muted)" }}
                  >
                    {s === "me" ? "Mine" : "Team"}
                  </Link>
                );
              })}
            </div>
          )}
          {view.progress.total > 0 && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-20 overflow-hidden rounded-full" style={{ background: "var(--hairline)" }} aria-hidden>
                <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: "var(--ink)" }} />
              </div>
              <span className="text-[12.5px] tabular-nums" style={{ color: "var(--ink-muted)" }}>
                {view.progress.done.toLocaleString("en-US")} of {view.progress.total.toLocaleString("en-US")} done
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {canAssign && (
            <button type="button" onClick={() => toggle("handout")} className="btn btn-secondary btn-sm" aria-expanded={panel === "handout"}>
              Hand out leads
            </button>
          )}
          <button type="button" onClick={() => toggle("add")} className="btn btn-primary btn-sm" aria-expanded={panel === "add"}>
            + Add to-do
          </button>
        </div>
      </div>

      {panel === "add" && (
        <div className="px-4 pb-4 sm:px-5">
          <AddTodo members={canAssign ? members : null} defaultAssignee={other?.id ?? meId} createAction={createAction} searchAction={searchAction} onDone={() => setPanel(null)} />
        </div>
      )}
      {panel === "handout" && (
        <div className="mx-4 mb-4 rounded-[14px] sm:mx-5" style={{ border: "1px solid var(--hairline)", background: "var(--surface-1)" }}>
          <QuickAssign embedded members={members} freeLeads={freeLeads} assignAction={assignAction} />
        </div>
      )}

      {view.kind === "team" ? (
        <TeamRows people={view.people} freeLeads={freeLeads} onHandOut={() => setPanel("handout")} />
      ) : (
        <ListBody view={view} statusAction={statusAction} callAction={callAction} />
      )}

      {view.kind === "list" && view.subject.isMe && (
        <div className="px-4 py-3 sm:px-5" style={{ borderTop: "1px solid var(--hairline-soft)" }}>
          <TaskDigestToggle enabled={digestEnabled} action={digestAction} />
        </div>
      )}
    </section>
  );
}

function TeamRows({ people, freeLeads, onHandOut }: { people: Person[]; freeLeads: number; onHandOut: () => void }) {
  return (
    <div className="flex flex-col pb-2">
      {people.length === 0 && (
        <div className="px-4 pb-4 text-[13.5px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
          Nobody has to-dos for today yet. Hand out leads, or add a to-do for someone.
        </div>
      )}
      {people.map((p) => {
        const segments = 10;
        const on = p.total ? Math.round((p.done / p.total) * segments) : 0;
        return (
          <Link key={p.id} href={`/dashboard?todo=${p.id}`} scroll={false} className="row-hover mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-[12px] px-2 py-2.5 sm:mx-3 sm:grid-cols-[minmax(0,1fr)_auto_72px] sm:px-3">
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium" style={{ color: "var(--ink)" }}>{p.name}</div>
              <div className="truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{p.next ? `Next: ${p.next}` : p.total ? "All done for today" : "Nothing today"}</div>
            </div>
            <div className="hidden gap-[2px] sm:flex" aria-hidden>
              {Array.from({ length: segments }, (_, i) => (
                <span key={i} className="h-3.5 w-[4px] rounded-[1px]" style={{ background: i < on ? "var(--ink)" : "var(--hairline)" }} />
              ))}
            </div>
            <div className="text-right text-[12.5px] tabular-nums" style={{ color: p.late ? "var(--tone-urgent)" : "var(--ink-muted)", fontWeight: p.late ? 500 : undefined }}>
              {p.late ? `${p.late.toLocaleString("en-US")} late` : p.total ? `${p.done} / ${p.total}` : "-"}
            </div>
          </Link>
        );
      })}
      {freeLeads > 0 && (
        <div className="mx-4 mt-1 flex items-center justify-between gap-3 pt-3 text-[13px] sm:mx-5" style={{ borderTop: "1px solid var(--hairline-soft)" }}>
          <span style={{ color: "var(--ink-muted)" }}>{freeLeads.toLocaleString("en-US")} {freeLeads === 1 ? "lead" : "leads"} nobody is working on</span>
          <button type="button" onClick={onHandOut} className="btn btn-secondary btn-sm">
            Hand out
          </button>
        </div>
      )}
    </div>
  );
}

function ListBody({ view, statusAction, callAction }: { view: Extract<TodoView, { kind: "list" }>; statusAction: StatusAction; callAction: CallAction }) {
  const [moreScheduled, setMoreScheduled] = useState(false);
  const [moreOther, setMoreOther] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const toggle = (key: string) => setOpened(opened === key ? null : key);
  const mine = view.subject.isMe;
  const nothing = !view.next && !view.scheduled.length && !view.queue.left && !view.other.length && !view.late.count;

  const chips = [
    view.late.count > 0 && { key: "late", label: `${view.late.count.toLocaleString("en-US")} late`, warn: true },
    view.done.count > 0 && { key: "done", label: `${view.done.count.toLocaleString("en-US")} done today`, warn: false },
    ...view.days.map((d) => ({ key: d.key, label: `${d.label} · ${d.count.toLocaleString("en-US")}`, warn: false })),
  ].filter(Boolean) as { key: string; label: string; warn: boolean }[];
  const openedDay = view.days.find((d) => d.key === opened);

  return (
    <div className="flex flex-col pb-3">
      {nothing && (
        <div className="px-4 pb-2 text-[13.5px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
          {view.done.count ? "All done for today." : "Nothing on the list today."}
        </div>
      )}

      {view.next && (
        <div className="px-2 sm:px-3">
          {view.queueMode && (
            <div className="flex items-center justify-between gap-3 px-2 pb-1.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              <span>Calling through your queue · {view.queue.left.toLocaleString("en-US")} left</span>
              <Link href="/dashboard?todo=me" scroll={false} className="font-medium" style={{ color: "var(--accent-blue)" }}>
                Stop
              </Link>
            </div>
          )}
          <Row row={view.next} next canAct statusAction={statusAction} callAction={callAction} />
        </div>
      )}

      {view.scheduled.length > 0 && (
        <Group title="Scheduled today">
          {(moreScheduled ? view.scheduled : view.scheduled.slice(0, SCHEDULED_SHOWN)).map((r) => (
            <Row key={r.key} row={r} canAct={mine || Boolean(r.taskId)} statusAction={statusAction} callAction={callAction} />
          ))}
          {view.scheduled.length > SCHEDULED_SHOWN && <More open={moreScheduled} hidden={view.scheduled.length - SCHEDULED_SHOWN} onClick={() => setMoreScheduled(!moreScheduled)} />}
        </Group>
      )}

      {view.queue.left > 0 && !view.queueMode && (
        <Group title="Call queue">
          <div className="mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] px-3 py-2.5 sm:mx-3" style={{ background: "var(--surface-2)" }}>
            <span aria-hidden className="flex h-[22px] w-[22px] flex-none items-center justify-center" style={{ color: "var(--ink-muted)" }}>
              <PhoneIcon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{view.queue.left.toLocaleString("en-US")} cold {view.queue.left === 1 ? "call" : "calls"} left</div>
              {view.queue.names.length > 0 && (
                <div className="truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
                  Next {view.queue.names.join(", ")}
                  {view.queue.left > view.queue.names.length + 1 ? "…" : ""}
                </div>
              )}
            </div>
            {mine && (
              <Link href="/dashboard?todo=me&queue=1" scroll={false} className="btn btn-secondary btn-sm flex-none">
                Start calling ›
              </Link>
            )}
          </div>
        </Group>
      )}

      {view.other.length > 0 && (
        <Group title="Follow-ups and other">
          {(moreOther ? view.other : view.other.slice(0, OTHER_SHOWN)).map((r) => (
            <Row key={r.key} row={r} canAct statusAction={statusAction} callAction={callAction} />
          ))}
          {view.other.length > OTHER_SHOWN && <More open={moreOther} hidden={view.other.length - OTHER_SHOWN} onClick={() => setMoreOther(!moreOther)} />}
        </Group>
      )}

      {chips.length > 0 && (
        <div className="mx-4 mt-3 flex flex-wrap gap-1.5 pt-3 sm:mx-5" style={{ borderTop: "1px solid var(--hairline-soft)" }}>
          {chips.map((c) => {
            const on = opened === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggle(c.key)}
                aria-expanded={on}
                className="rounded-full px-3 py-1 text-[12.5px] font-medium"
                style={{
                  border: `1px solid ${c.warn ? "var(--tone-urgent)" : on ? "var(--ink)" : "var(--hairline)"}`,
                  color: c.warn ? "var(--tone-urgent)" : on ? "var(--ink)" : "var(--ink-muted)",
                  background: on ? "var(--surface-2)" : undefined,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      {opened === "late" && <Opened rows={view.late.rows} total={view.late.count} statusAction={statusAction} callAction={callAction} />}
      {opened === "done" && <Opened rows={view.done.rows} total={view.done.count} statusAction={statusAction} callAction={callAction} />}
      {openedDay && (
        <div className="mx-4 mt-2 flex flex-col gap-1 text-[13px] sm:mx-5">
          {openedDay.items.map((i, k) => (
            <div key={k} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3">
              <span className="text-right tabular-nums" style={{ color: "var(--ink-muted)" }}>{i.time}</span>
              <span className="min-w-0 break-words">{i.title}</span>
            </div>
          ))}
          {openedDay.count > openedDay.items.length && (
            <div className="pl-[60px] text-[12.5px]" style={{ color: "var(--ink-muted)" }}>and {(openedDay.count - openedDay.items.length).toLocaleString("en-US")} more</div>
          )}
        </div>
      )}
    </div>
  );
}

// An opened chip: ten at a time, so even this stays short.
function Opened({ rows, total, statusAction, callAction }: { rows: TodoRow[]; total: number; statusAction: StatusAction; callAction: CallAction }) {
  const [shown, setShown] = useState(10);
  return (
    <div className="mt-2 flex flex-col">
      {rows.slice(0, shown).map((r) => (
        <Row key={r.key} row={r} canAct statusAction={statusAction} callAction={callAction} />
      ))}
      {rows.length > shown && <More open={false} hidden={Math.min(20, rows.length - shown)} onClick={() => setShown(shown + 20)} />}
      {rows.length <= shown && total > rows.length && (
        <div className="px-4 py-2 text-[12.5px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
          and {(total - rows.length).toLocaleString("en-US")} more. <Link href="/leads" style={{ color: "var(--accent-blue)" }}>See them in Leads</Link>
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-col">
      <div className="px-4 pb-1 pt-1.5 text-[11.5px] font-semibold uppercase sm:px-5" style={{ letterSpacing: "0.6px", color: "var(--ink-muted)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function More({ open, hidden, onClick }: { open: boolean; hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mx-2 rounded-[10px] px-2 py-1.5 text-left text-[13px] font-medium sm:mx-3 sm:px-3" style={{ color: "var(--accent-blue)", paddingLeft: "calc(56px + 22px + 1.5rem)" }}>
      {open ? "Show fewer" : `Show ${hidden.toLocaleString("en-US")} more`}
    </button>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 2.5h2.5l1.2 3-1.6 1a8 8 0 0 0 4.4 4.4l1-1.6 3 1.2V13a1.5 1.5 0 0 1-1.5 1.5A11.5 11.5 0 0 1 1.5 4 1.5 1.5 0 0 1 3 2.5Z" />
    </svg>
  );
}

// canAct: show Call and Skip (the checkbox always works for to-dos).
function Row({ row, next, canAct, statusAction, callAction }: { row: TodoRow; next?: boolean; canAct: boolean; statusAction: StatusAction; callAction: CallAction }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const finished = row.status !== "open";
  const set = (status: "open" | "done" | "skipped") =>
    startTransition(async () => {
      await statusAction(row.taskId!, status);
      router.refresh();
    });
  const ink = next ? "var(--on-surface-inverted)" : "var(--ink)";
  const muted = next ? "var(--on-surface-inverted-muted)" : "var(--ink-muted)";
  const actions = !finished && row.taskId && canAct;

  const mark = row.taskId ? (
    <button
      type="button"
      disabled={pending}
      onClick={() => set(finished ? "open" : "done")}
      aria-label={finished ? `Reopen: ${row.title}` : `Mark done: ${row.title}`}
      className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full"
      style={finished ? { background: row.status === "done" ? "var(--ink)" : "var(--hairline)", color: "var(--surface-1)" } : { boxShadow: `inset 0 0 0 1.5px ${next ? "var(--on-surface-inverted-muted)" : row.late ? "var(--tone-urgent)" : "var(--hairline)"}` }}
    >
      {finished && (
        <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {row.status === "done" ? <path d="M3.5 8.5 6.5 11.5 12.5 5" /> : <path d="M4.5 8h7" />}
        </svg>
      )}
    </button>
  ) : (
    <span aria-hidden className="flex h-[22px] w-[22px] flex-none items-center justify-center" style={{ color: muted }}>
      {row.icon === "event" ? (
        <svg viewBox="0 0 16 16" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.5" y="4" width="9" height="8" rx="2" />
          <path d="m10.5 7 4-2v6l-4-2" />
        </svg>
      ) : row.icon === "call" ? (
        <PhoneIcon />
      ) : (
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--tone-due)" }} />
      )}
    </span>
  );

  const titleEl = (
    <span className="break-words text-[14px] font-medium" style={{ color: finished ? "var(--ink-muted)" : ink }}>
      {row.title}
    </span>
  );

  return (
    <div className={`mx-2 flex items-start gap-3 rounded-[12px] px-2 py-2 sm:mx-3 sm:px-3 ${next ? "py-3" : ""}`} style={{ ...(next ? { background: "var(--surface-inverted)" } : {}), opacity: pending ? 0.6 : 1 }}>
      <span className="w-[56px] flex-none pt-[3px] text-right text-[12.5px] tabular-nums" style={{ color: row.late ? "var(--tone-urgent)" : muted, fontWeight: row.late || next ? 500 : undefined }}>
        {row.time ?? ""}
      </span>
      {mark}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {row.href ? row.href.startsWith("http") ? <a href={row.href} target="_blank" rel="noreferrer">{titleEl}</a> : <Link href={row.href}>{titleEl}</Link> : titleEl}
          {row.chip && <span className={`chip ${row.chip.cls}`}>{row.chip.label}</span>}
        </div>
        {row.detail && <div className="mt-0.5 break-words text-[12.5px]" style={{ color: muted }}>{row.detail}</div>}
        {/* On a phone the buttons sit under the text. */}
        {actions && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:hidden">
            <Actions row={row} next={next} pending={pending} set={set} callAction={callAction} />
          </div>
        )}
      </div>
      {actions && (
        <div className="hidden flex-none items-center gap-1.5 sm:flex">
          <Actions row={row} next={next} pending={pending} set={set} callAction={callAction} />
        </div>
      )}
    </div>
  );
}

function Actions({ row, next, pending, set, callAction }: { row: TodoRow; next?: boolean; pending: boolean; set: (s: "open" | "done" | "skipped") => void; callAction: CallAction }) {
  return (
    <>
      {row.call?.phone && <LeadCallButton variant="compact" primary={Boolean(next)} leadName={row.call.leadName} startAction={(input) => callAction(row.call!.leadId, input)} />}
      <button type="button" disabled={pending} onClick={() => set("skipped")} className="btn btn-ghost btn-sm" style={next ? { color: "var(--on-surface-inverted-muted)" } : undefined}>
        Skip
      </button>
    </>
  );
}

// "+ Add to-do": what, for whom, which lead (optional for an Other
// to-do), which day.
function AddTodo({
  members,
  defaultAssignee,
  createAction,
  searchAction,
  onDone,
}: {
  members: Member[] | null;
  defaultAssignee: string;
  createAction: (input: TaskDraft & { timezone: string; leadId: string | null }) => Promise<void>;
  searchAction: (q: string) => Promise<{ id: string; name: string; company: string | null }[]>;
  onDone: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<TaskDraft>({ assigneeId: defaultAssignee, type: "cold_call", dueDate: todayLocal(), dueTime: "", priority: "normal", note: "" });
  const [lead, setLead] = useState<{ id: string; name: string; company: string | null } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; company: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (lead || query.trim().length < 2) return;
    timer.current = setTimeout(() => {
      searchAction(query.trim())
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, lead, searchAction]);

  // Old matches don't linger once the search is cleared or a lead is picked.
  const shown = lead || query.trim().length < 2 ? [] : results;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!lead && draft.type !== "other") return setError("Pick a lead, or make it an Other to-do");
    if (!lead && !draft.note.trim()) return setError("Write what needs doing");
    startTransition(async () => {
      try {
        await createAction({ ...draft, timezone: viewerTimeZone(), leadId: lead?.id ?? null });
        router.refresh();
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add the to-do");
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5 rounded-[14px] p-4" style={{ border: "1px solid var(--hairline)", background: "var(--surface-1)" }}>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>Lead {draft.type === "other" ? "(optional)" : ""}</span>
        {lead ? (
          <div className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2" style={{ border: "1px solid var(--hairline)" }}>
            <span className="min-w-0 truncate text-[13.5px]">
              <span className="font-medium">{lead.name}</span>
              {lead.company && <span style={{ color: "var(--ink-muted)" }}> · {lead.company}</span>}
            </span>
            <button type="button" onClick={() => setLead(null)} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
              Change
            </button>
          </div>
        ) : (
          <div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or company" className="input w-full" autoComplete="off" disabled={pending} />
            {shown.length > 0 && (
              <div className="mt-1 overflow-hidden rounded-[10px]" style={{ border: "1px solid var(--hairline)", background: "var(--surface-1)" }}>
                {shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setLead(r);
                      setQuery("");
                    }}
                    className="row-hover block w-full px-3 py-2 text-left text-[13.5px]"
                  >
                    <span className="font-medium">{r.name}</span>
                    {r.company && <span style={{ color: "var(--ink-muted)" }}> · {r.company}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </label>
      <TaskFields draft={draft} setDraft={setDraft} assignees={members} disabled={pending} />
      {error && <div className="chip chip-warn w-fit max-w-full whitespace-normal px-3 py-1.5 text-[12.5px]">{error}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary btn-sm">
          {pending ? "Adding…" : "Add to-do"}
        </button>
        <button type="button" disabled={pending} onClick={onDone} className="btn btn-secondary btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
