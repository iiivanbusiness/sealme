import { LEAD_INTERESTS, LEAD_INTEREST_LABEL } from "@/lib/lead-stages";

type LeadValues = {
  name?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
  ownerId?: string | null;
  interest?: string | null;
  isDecisionMaker?: boolean | null;
  painPoints?: string | null;
  objections?: string | null;
  notes?: string | null;
  nextStep?: string | null;
  nextStepAt?: Date | null;
  campaign?: string | null;
};

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

// The same inputs for "Add lead" and editing one, so both stay in step.
export default function LeadFields({
  values = {},
  owners,
  full,
  allowUnassigned = true,
  campaigns = [],
}: {
  values?: LeadValues;
  owners: { id: string; name: string }[];
  full?: boolean;
  allowUnassigned?: boolean;
  campaigns?: string[]; // the workspace's campaigns so far, offered as suggestions
}) {
  const day = values.nextStepAt ? values.nextStepAt.toISOString().slice(0, 10) : "";
  const decision = values.isDecisionMaker === true ? "yes" : values.isDecisionMaker === false ? "no" : "";
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Name">
        <input name="name" required pattern=".*\S.*" title="Add the lead's name" defaultValue={values.name ?? ""} placeholder="Lisa Smith" className="input" autoComplete="off" />
      </Field>
      <Field label="Company">
        <input name="company" defaultValue={values.company ?? ""} placeholder="RxBenefits" className="input" autoComplete="off" />
      </Field>
      <Field label="Title">
        <input name="title" defaultValue={values.title ?? ""} placeholder="Director of Revenue Operations" className="input" autoComplete="off" />
      </Field>
      <Field label="Owner">
        <select name="ownerId" defaultValue={values.ownerId ?? ""} className="input" disabled={!allowUnassigned && owners.length <= 1}>
          {allowUnassigned && <option value="">Unassigned</option>}
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Email">
        <input name="email" type="email" pattern="[^@\s]+@[^@\s]+\.[^@\s]+" title="Like lisa@company.com" defaultValue={values.email ?? ""} placeholder="lisa@company.com" className="input" autoComplete="off" />
      </Field>
      <Field label="Phone">
        <input name="phone" type="tel" defaultValue={values.phone ?? ""} placeholder="+1 512 555 0100" className="input" autoComplete="off" />
      </Field>
      {/* Only where campaigns are used, or on a lead's full edit form. */}
      {(full || campaigns.length > 0) && (
        <Field label="Campaign">
          <input name="campaign" list="lead-campaigns" defaultValue={values.campaign ?? ""} placeholder="Acme Freight Q4" className="input" autoComplete="off" />
          <datalist id="lead-campaigns">
            {campaigns.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      )}
      {full && (
        <>
          <Field label="Website">
            <input name="domain" defaultValue={values.domain ?? ""} placeholder="company.com" className="input" autoComplete="off" />
          </Field>
          <Field label="Interest">
            <select name="interest" defaultValue={values.interest ?? ""} className="input">
              <option value="">Not known yet</option>
              {LEAD_INTERESTS.map((i) => (
                <option key={i} value={i}>{LEAD_INTEREST_LABEL[i]}</option>
              ))}
            </select>
          </Field>
          <Field label="Decision maker">
            <select name="isDecisionMaker" defaultValue={decision} className="input">
              <option value="">Not known yet</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Next step date">
            <input name="nextStepAt" type="date" defaultValue={day} className="input" />
          </Field>
          <Field label="Next step" wide>
            <input name="nextStep" defaultValue={values.nextStep ?? ""} placeholder="Send case studies, call back Tuesday" className="input" autoComplete="off" />
          </Field>
          <Field label="Pain points" wide>
            <textarea name="painPoints" rows={2} defaultValue={values.painPoints ?? ""} className="input" />
          </Field>
          <Field label="Objections" wide>
            <textarea name="objections" rows={2} defaultValue={values.objections ?? ""} className="input" />
          </Field>
          <Field label="Notes" wide>
            <textarea name="notes" rows={4} defaultValue={values.notes ?? ""} className="input" />
          </Field>
        </>
      )}
    </div>
  );
}
