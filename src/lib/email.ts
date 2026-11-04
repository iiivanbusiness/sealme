import { Resend } from "resend";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function fromAddress(workspaceName: string, verifiedSenderEmail?: string | null): string {
  if (verifiedSenderEmail) return `${workspaceName} <${verifiedSenderEmail}>`;
  const address = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  return `${workspaceName} via SealMe <${address}>`;
}

export async function sendContractEmail(options: {
  to: string;
  cc?: string[];
  subject: string;
  message: string;
  signLink: string;
  workspaceName: string;
  replyTo?: string | null;
  verifiedSenderEmail?: string | null;
  portalUrl?: string | null;
}): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const messageHtml = options.message
    .split("\n")
    .map((line) => `<p style="margin:0 0 14px;">${escapeHtml(line)}</p>`)
    .join("");

  const footer = options.verifiedSenderEmail
    ? `Sent by ${escapeHtml(options.workspaceName)}`
    : `Sent by ${escapeHtml(options.workspaceName)} via SealMe`;

  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1d1d1f;">
      ${messageHtml}
      <a href="${options.signLink}" style="display:inline-block;margin:12px 0 8px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        View &amp; sign the agreement
      </a>
      ${options.portalUrl ? `<p style="margin:0 0 20px;"><a href="${options.portalUrl}" style="color:#6e6e73;font-size:12.5px;">View all your agreements with ${escapeHtml(options.workspaceName)}</a></p>` : `<div style="margin-bottom:20px;"></div>`}
      <p style="margin:0;font-size:12.5px;color:#6e6e73;">${footer}</p>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: fromAddress(options.workspaceName, options.verifiedSenderEmail),
    to: options.to,
    ...(options.cc && options.cc.length > 0 ? { cc: options.cc } : {}),
    subject: options.subject,
    html,
    ...(!options.verifiedSenderEmail && options.replyTo ? { replyTo: options.replyTo } : {}),
  });

  if (error) throw new Error(error.message);
}

// Sent to a counter-signer once it's their turn in the routing order — the
// client (and any earlier counter-signer) already signed, this person is
// next. Deliberately its own function rather than reusing
// sendContractEmail: there's no human-composed message here, just a
// standard notice, and no CC (each signer gets their own turn-specific
// email, not the original send's CC list).
export async function sendCountersignRequestEmail(options: {
  to: string;
  signerName: string;
  clientName: string;
  templateName: string;
  signLink: string;
  workspaceName: string;
  replyTo?: string | null;
  verifiedSenderEmail?: string | null;
}): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const footer = options.verifiedSenderEmail
    ? `Sent by ${escapeHtml(options.workspaceName)}`
    : `Sent by ${escapeHtml(options.workspaceName)} via SealMe`;

  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1d1d1f;">
      <p style="margin:0 0 14px;">Hi ${escapeHtml(options.signerName)},</p>
      <p style="margin:0 0 14px;">The agreement between ${escapeHtml(options.workspaceName)} and ${escapeHtml(options.clientName)} (${escapeHtml(options.templateName)}) is ready for your signature.</p>
      <a href="${options.signLink}" style="display:inline-block;margin:12px 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Review &amp; sign
      </a>
      <p style="margin:0;font-size:12.5px;color:#6e6e73;">${footer}</p>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: fromAddress(options.workspaceName, options.verifiedSenderEmail),
    to: options.to,
    subject: `Your signature is needed: ${options.clientName} - ${options.templateName}`,
    html,
    ...(!options.verifiedSenderEmail && options.replyTo ? { replyTo: options.replyTo } : {}),
  });

  if (error) throw new Error(error.message);
}

function systemFromAddress(): string {
  const address = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  return `SealMe <${address}>`;
}

// Internal product notifications (to the workspace's own team, not a client) —
// always sent from SealMe itself, regardless of any verified sending domain.
async function sendSystemEmail(options: { to: string[]; subject: string; bodyHtml: string }): Promise<void> {
  if (options.to.length === 0) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1d1d1f;">
      ${options.bodyHtml}
    </div>
  `;
  const { error } = await resend.emails.send({
    from: systemFromAddress(),
    to: options.to,
    subject: options.subject,
    html,
  });
  if (error) throw new Error(error.message);
}

export async function sendSignedNotificationEmail(options: {
  to: string[];
  clientName: string;
  templateName: string;
  contractUrl: string;
}): Promise<void> {
  await sendSystemEmail({
    to: options.to,
    subject: `${options.clientName} signed the ${options.templateName}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">${escapeHtml(options.clientName)} just signed the ${escapeHtml(options.templateName)}.</p>
      <a href="${options.contractUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        View the signed contract
      </a>
    `,
  });
}

export async function sendReminderEmail(options: {
  to: string;
  clientName: string;
  workspaceName: string;
  signLink: string;
  verifiedSenderEmail?: string | null;
}): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1d1d1f;">
      <p style="margin:0 0 14px;">Hi ${escapeHtml(options.clientName.split(" ")[0])}, just a friendly nudge. Your agreement with ${escapeHtml(options.workspaceName)} is still waiting for a signature.</p>
      <a href="${options.signLink}" style="display:inline-block;margin:12px 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Review &amp; sign
      </a>
    </div>
  `;
  const { error } = await resend.emails.send({
    from: fromAddress(options.workspaceName, options.verifiedSenderEmail),
    to: options.to,
    subject: `Reminder: your agreement with ${options.workspaceName} is waiting for signature`,
    html,
  });
  if (error) throw new Error(error.message);
}

// An invite either carries a link to set a password (someone a teammate
// invited) or just points at sign-in (provisioned by the company's IT over
// SCIM, who sign in through their company account).
export async function sendTeammateInviteEmail(options: {
  to: string;
  inviterName: string;
  workspaceName: string;
  setPasswordUrl?: string;
  loginUrl?: string;
}): Promise<void> {
  const button = (href: string, label: string) =>
    `<a href="${href}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">${label}</a>`;
  await sendSystemEmail({
    to: [options.to],
    subject: `${options.inviterName} invited you to ${options.workspaceName} on SealMe`,
    bodyHtml: options.setPasswordUrl
      ? `
      <p style="margin:0 0 14px;">${escapeHtml(options.inviterName)} invited you to join <strong>${escapeHtml(options.workspaceName)}</strong> on SealMe.</p>
      <p style="margin:0 0 14px;">Set your password to get in. The link works for 7 days.</p>
      ${button(options.setPasswordUrl, "Set your password")}
      <p style="margin:0 0 14px;color:#6e6e73;">If this address is a Google account, you can also sign in with Google on the web. The desktop and iPhone apps use email and password (Forgot password sets one).</p>
    `
      : `
      <p style="margin:0 0 14px;">${escapeHtml(options.inviterName)} invited you to join <strong>${escapeHtml(options.workspaceName)}</strong> on SealMe.</p>
      <p style="margin:0 0 14px;">Sign in with your company account using this email address (${escapeHtml(options.to)}). On the web, Google works too.</p>
      ${button(options.loginUrl ?? "", "Sign in")}
    `,
  });
}

export async function sendStaleDealsEmail(options: {
  to: string[];
  deals: { clientName: string; service: string; daysSinceUpdate: number; dealUrl: string }[];
}): Promise<void> {
  if (options.deals.length === 0) return;
  const rows = options.deals
    .map(
      (d) => `
      <p style="margin:0 0 10px;">
        <a href="${d.dealUrl}" style="color:#1d1d1f;font-weight:600;text-decoration:none;">${escapeHtml(d.clientName)}</a>
        - ${escapeHtml(d.service)} <span style="color:#6e6e73;">(untouched ${d.daysSinceUpdate} days)</span>
      </p>`
    )
    .join("");
  await sendSystemEmail({
    to: options.to,
    subject: `${options.deals.length} deal${options.deals.length === 1 ? "" : "s"} sitting untouched`,
    bodyHtml: `
      <p style="margin:0 0 14px;">These deals have been waiting on a review or a send for a while. Worth a quick look before they go cold:</p>
      ${rows}
    `,
  });
}

export async function sendReviewAssignedEmail(options: {
  to: string;
  clientName: string;
  templateName: string;
  dealUrl: string;
}): Promise<void> {
  await sendSystemEmail({
    to: [options.to],
    subject: `Review needed: ${options.clientName} - ${options.templateName}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">A contract for <strong>${escapeHtml(options.clientName)}</strong> (${escapeHtml(options.templateName)}) is waiting on your review before it can go out.</p>
      <a href="${options.dealUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Review &amp; decide
      </a>
    `,
  });
}

// To the rep, once a sales call has turned into a deal: the contract is
// ready to review, already sent, or waiting on details the call missed.
export async function sendContractReadyEmail(options: { to: string; subject: string; message: string; actionLabel: string; url: string }): Promise<void> {
  await sendSystemEmail({
    to: [options.to],
    subject: options.subject,
    bodyHtml: `
      <p style="margin:0 0 14px;">${escapeHtml(options.message)}</p>
      <a href="${options.url}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        ${escapeHtml(options.actionLabel)}
      </a>
    `,
  });
}

export async function sendReviewOverdueEmail(options: {
  to: string;
  clientName: string;
  templateName: string;
  dealUrl: string;
}): Promise<void> {
  await sendSystemEmail({
    to: [options.to],
    subject: `Overdue: ${options.clientName} - ${options.templateName}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">Your review of the contract for <strong>${escapeHtml(options.clientName)}</strong> (${escapeHtml(options.templateName)}) is past its due date.</p>
      <a href="${options.dealUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Review &amp; decide
      </a>
    `,
  });
}


export async function sendChangesRequestedEmail(options: {
  to: string[];
  clientName: string;
  templateName: string;
  dealUrl: string;
  decidedByName: string;
  note?: string | null;
}): Promise<void> {
  await sendSystemEmail({
    to: options.to,
    subject: `Changes requested: ${options.clientName} - ${options.templateName}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">${escapeHtml(options.decidedByName)} requested changes on the contract for <strong>${escapeHtml(options.clientName)}</strong> before it can be sent.</p>
      ${options.note ? `<p style="margin:0 0 14px;font-style:italic;">&ldquo;${escapeHtml(options.note)}&rdquo;</p>` : ""}
      <a href="${options.dealUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        View deal
      </a>
    `,
  });
}

export type TaskDigestItem = { leadName: string; kind: string; when: string; company: string | null; overdue: boolean };

// The morning "your tasks" email. Built separately from sending so the
// cron can stay simple and the layout can be checked without sending.
export function taskDigestEmail(options: {
  firstName: string | null;
  isToday: boolean;
  dayLabel: string; // "Friday, October 2"
  summary: string; // "8 cold calls, 2 sales calls, 1 follow-up"
  overdueCount: number;
  items: TaskDigestItem[];
  moreCount: number;
  todayUrl: string;
}): { subject: string; bodyHtml: string } {
  const when = options.isToday ? "today" : "tomorrow";
  const overdue = options.overdueCount > 0 ? `${options.overdueCount} overdue` : "";
  const subject = `Your tasks ${when}: ${[options.summary, overdue].filter(Boolean).join(", ")}`;
  const rows = options.items
    .map(
      (i) => `
      <p style="margin:0 0 10px;">
        <strong>${escapeHtml(i.leadName)}</strong>
        <span style="color:${i.overdue ? "#b45309" : "#6e6e73"};"> - ${escapeHtml([i.kind, i.when].filter(Boolean).join(" · "))}</span>${i.company ? `<span style="color:#6e6e73;"> (${escapeHtml(i.company)})</span>` : ""}
      </p>`
    )
    .join("");
  const bodyHtml = `
    <p style="margin:0 0 14px;">${options.isToday ? "Good morning" : "Hi"}${options.firstName ? `, ${escapeHtml(options.firstName)}` : ""}. Here's your list for ${escapeHtml(options.dayLabel)}: ${escapeHtml(options.summary || "nothing new")}.${options.overdueCount > 0 ? ` ${options.overdueCount === 1 ? "One task is" : `${options.overdueCount} tasks are`} overdue from earlier days.` : ""}</p>
    ${rows}
    ${options.moreCount > 0 ? `<p style="margin:0 0 14px;color:#6e6e73;">And ${options.moreCount} more.</p>` : ""}
    <a href="${options.todayUrl}" style="display:inline-block;margin:6px 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
      Open Today
    </a>
    <p style="margin:0;color:#6e6e73;font-size:12px;">You get this because tasks are assigned to you in SealMe. You can turn it off at the bottom of the Today page.</p>
  `;
  return { subject, bodyHtml };
}

export async function sendTaskDigestEmail(to: string, content: { subject: string; bodyHtml: string }): Promise<void> {
  await sendSystemEmail({ to: [to], subject: content.subject, bodyHtml: content.bodyHtml });
}

export async function sendRenewalReminderEmail(options: {
  to: string[];
  clientName: string;
  templateName: string;
  renewalDate: Date;
  autoRenews: boolean;
  renewalNote?: string | null;
  dealUrl: string;
}): Promise<void> {
  const dateLabel = options.renewalDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  await sendSystemEmail({
    to: options.to,
    subject: `${options.clientName}'s contract ${options.autoRenews ? "renews" : "ends"} on ${dateLabel}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">The ${escapeHtml(options.templateName)} with <strong>${escapeHtml(options.clientName)}</strong> ${options.autoRenews ? "auto-renews" : "ends"} on <strong>${dateLabel}</strong>. Coming up in the next 30 days.</p>
      ${options.renewalNote ? `<p style="margin:0 0 14px;font-style:italic;">${escapeHtml(options.renewalNote)}</p>` : ""}
      <a href="${options.dealUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Review &amp; start renewal
      </a>
    `,
  });
}

export async function sendVerificationEmail(options: { to: string; verifyUrl: string }): Promise<void> {
  await sendSystemEmail({
    to: [options.to],
    subject: "Verify your email for SealMe",
    bodyHtml: `
      <p style="margin:0 0 14px;">One quick step. Confirm this is your email address to finish setting up SealMe.</p>
      <a href="${options.verifyUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Verify email
      </a>
      <p style="margin:0;font-size:12.5px;color:#6e6e73;">If you didn&apos;t create a SealMe account, you can ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(options: { to: string; resetUrl: string }): Promise<void> {
  await sendSystemEmail({
    to: [options.to],
    subject: "Reset your SealMe password",
    bodyHtml: `
      <p style="margin:0 0 14px;">Someone requested a password reset for this email address. If that was you, set a new password below. This link expires in 1 hour.</p>
      <a href="${options.resetUrl}" style="display:inline-block;margin:0 0 20px;padding:12px 22px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Reset password
      </a>
      <p style="margin:0;font-size:12.5px;color:#6e6e73;">If you didn&apos;t request this, you can ignore this email.</p>
    `,
  });
}

// A new person in SealMe, to the founder: who, which workspace, how they
// got in, and how many real people that makes.
export async function sendSignupAlertEmail(options: { to: string; name: string; email: string; workspaceName: string; how: string; peopleSoFar: number; adminUrl: string }): Promise<void> {
  const name = escapeHtml(options.name);
  const email = escapeHtml(options.email);
  await sendSystemEmail({
    to: [options.to],
    subject: `New sign-up: ${options.name === options.email ? options.email : `${options.name} (${options.email})`}`,
    bodyHtml: `
      <p style="margin:0 0 6px;font-size:16px;font-weight:600;">${name}</p>
      <p style="margin:0 0 14px;color:#6e6e73;">${email}</p>
      <p style="margin:0 0 4px;"><strong>Workspace:</strong> ${escapeHtml(options.workspaceName)}</p>
      <p style="margin:0 0 4px;"><strong>How:</strong> ${escapeHtml(options.how)}</p>
      <p style="margin:0 0 18px;"><strong>People in SealMe so far:</strong> ${options.peopleSoFar}</p>
      <a href="${options.adminUrl}" style="display:inline-block;padding:11px 20px;background:#1d1d1f;color:#ffffff;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px;">
        Open Admin
      </a>
    `,
  });
}

// Cross-tenant platform failures — sent to ADMIN_EMAILS, not any one workspace's
// team, so problems surface before a customer has to report them.
export async function sendAdminAlertEmail(options: { subject: string; details: string }): Promise<void> {
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (admins.length === 0) return;

  await sendSystemEmail({
    to: admins,
    subject: `[SealMe alert] ${options.subject}`,
    bodyHtml: `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px;background:#f5f5f5;padding:12px;border-radius:8px;">${escapeHtml(options.details)}</pre>`,
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
