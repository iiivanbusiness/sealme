import Link from "next/link";
import { createEvent } from "../actions";

// A meeting that isn't on the connected Google Calendar. The date and time
// are read on the rep's own clock (see createEvent).
export default async function NewMeetingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <>
    <Link href="/calendar" className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Calendar
    </Link>

    <div className="mb-6 max-w-[480px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>New meeting</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        Add a meeting that isn&apos;t on your Google Calendar.
      </div>
    </div>

    {error && <div className="chip chip-warn mb-4 w-full max-w-[480px] justify-start whitespace-normal px-4 py-2.5 text-[12.5px]">{error}</div>}

    <form action={createEvent} className="card flex max-w-[480px] flex-col gap-4 p-6">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Title</span>
        <input name="title" required maxLength={200} placeholder="Discovery call with Northgate Fitness" className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Who it&apos;s with (optional)</span>
        <input name="clientName" maxLength={200} placeholder="Dana Lee" className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Email (optional)</span>
        <input name="attendeeEmail" type="email" placeholder="dana@northgatefitness.com" className="input" autoComplete="off" />
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Start call uses it to find their lead, or to start one.
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Date &amp; time</span>
        <input name="startTime" type="datetime-local" required className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Meeting link (optional)</span>
        <input name="meetingUrl" placeholder="https://zoom.us/j/... or meet.google.com/..." className="input" />
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          So you can join it from SealMe.
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Length (min)</span>
        <input name="durationMinutes" type="number" defaultValue={30} min={5} max={720} step={5} className="input" />
      </label>
      <button type="submit" className="btn btn-primary mt-2 w-full justify-center">
        Add meeting
      </button>
    </form>
    </>
  );
}
