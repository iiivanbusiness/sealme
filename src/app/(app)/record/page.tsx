import { redirect } from "next/navigation";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import MeetingRecorder from "@/components/MeetingRecorder";
import { saveRecordedMeeting } from "../deals/new/actions";
import { searchTodoLeads } from "../leads/task-actions";

// Recording a meeting is the iPhone app's: its recorder is native, so it
// keeps going with the screen locked. In a browser, Notes takes an upload.
export default async function RecordPage() {
  await requireProspecting();
  if (!(await isPhoneApp())) redirect("/notes");

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Record a meeting</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          SealMe records on this phone, then writes up the notes on the client&apos;s file.
        </div>
      </div>
      <MeetingRecorder save={saveRecordedMeeting} searchLeads={searchTodoLeads} />
    </>
  );
}
