import { navGroupsFor } from "@/lib/nav-config";

// Canned Q&A for the FAQ chat widget (see FaqChatWidget.tsx). No AI call,
// no cost — this is a static lookup the user clicks through. Answers are
// grounded in what the app actually does; keep this file in sync with real
// behavior instead of writing aspirational copy.

export type FaqQuestion = {
  question: string;
  answer: string;
};

export type FaqCategory = {
  id: string;
  label: string;
  questions: FaqQuestion[];
  // Only for workspaces with Leads turned on (prospecting).
  prospecting?: boolean;
};

export function faqCategoriesFor(prospecting: boolean): FaqCategory[] {
  return FAQ_CATEGORIES.filter((c) => prospecting || !c.prospecting);
}

// Flattened into plain text and used as the grounding facts for the
// freeform AI support chat's system prompt (see support-chat/route.ts) —
// one source of truth for what the product actually does, instead of
// letting the model guess at features.
// Where things actually are in the app, so the AI chat can answer
// navigation questions ("where do I connect Salesforce", "where are my
// deals") without needing any account data. This is app structure, not
// account content, so it stays fine under the no-account-access rule.
export function appNavigationText(prospecting = false): string {
  const sidebar = navGroupsFor({ prospecting, admin: false })
    .map((g) => `${g.label ? `${g.label}: ` : ""}${g.items.map((item) => `${item.label} (${item.href})`).join(", ")}`)
    .join("; ");
  return (
    `Left sidebar, top to bottom, in sections: ${sidebar}. On a phone, the bottom bar has the main four and the menu button opens the rest.\n\n` +
    (prospecting
      ? "Dashboard: a Today card at the top with one folder per thing (Team today for managers, Next up, Your day, Waiting on you, " +
        "Notifications, Deals, Hand out work for managers, Calendar), each with a colored dot for how urgent it is. Tap a folder to open it; " +
        "Customize in that card hides or reorders folders. The deal widgets sit below it, with their own Customize.\n\n" +
        "Leads: the lead list with search and filters, Import (paste, CSV or Excel) and + Add lead at the top. Select leads and click Assign to give them to a rep. " +
        "Open a lead to call it, add a cold call transcript, or Convert to deal.\n\n" +
        "Calls: calls that need a look (Pending) and every call SealMe handled (History).\n\n" +
        "Notes (under Closing): add a recording, video or transcript of a call and get only the notes and next step, no contract. Below it, every client that has notes, newest call first; each one opens that client's lead with all their calls.\n\n" +
        "Team (under Workspace, managers only): each rep's tasks, calls and results, and moving tasks between reps.\n\n" +
        "Your phone number: on the Settings page, its own section, where you add and verify the number SealMe rings when you tap Call.\n\n"
      : "") +
    "Deals: click Deals in the sidebar, or go to /deals. Table and Board views, filterable by status and owner. " +
    "Click + Start a call to begin a new deal, either recording locally, pasting a transcript, or entering details by hand.\n\n" +
    "Clients: Clients in the sidebar lists every client across all deals.\n\n" +
    "Contract templates: Templates in the sidebar, where you create and edit the templates deals are built from.\n\n" +
    "Everything below lives on the Settings page (Settings in the sidebar), as separate sections you scroll through:\n" +
    "- Workspace name and logo\n" +
    "- Team: invite teammates, assign roles, set up teams and approval chains, assign approval backups\n" +
    "- Access & provisioning: restrict sign-ups to an email domain, SCIM provisioning, single sign-on (OIDC)\n" +
    "- Integrations, each its own row with a Connect button: Slack, HubSpot, DocuSign, Salesforce\n" +
    "- Bulk import: bring clients and deals in from a CSV\n" +
    "- API & webhooks: generate API keys, set up webhook endpoints\n" +
    "- Two-factor authentication\n" +
    "- Sending domain: verify your own domain so contracts go out as you\n" +
    "- Notification toggles: require manual approval before sending, email me when signed, auto-remind clients, signing/reminder timing\n" +
    "- Delete account\n\n" +
    "To connect or check a CRM/integration (Salesforce, HubSpot, Slack, DocuSign): go to Settings and find that " +
    "integration's row, it shows Connect if not linked yet, or who it's connected as if it already is."
  );
}

export function faqKnowledgeText(prospecting = false): string {
  return faqCategoriesFor(prospecting).map(
    (category) =>
      `## ${category.label}\n` +
      category.questions.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n")
  ).join("\n\n");
}

export const FAQ_CATEGORIES: FaqCategory[] = [
  {
    id: "today",
    label: "Leads and your day",
    prospecting: true,
    questions: [
      {
        question: "Where do I see what I have to do today?",
        answer:
          "On the Dashboard. The Today folders show your next call, the rest of your day, what's waiting on you and new notifications. A red dot means late, orange needs you today, blue is new and green is all good. Tap a folder to open it, and use Customize in that card to hide or reorder folders.",
      },
      {
        question: "How do I get leads into SealMe?",
        answer:
          "Go to Leads and click Import. Paste rows from Excel or Google Sheets, or upload a CSV or Excel file; Apollo and Clay columns are recognized on their own. A lead with the same email, phone or CRM ID is updated instead of added twice. You can also click + Add lead, or bring leads in from HubSpot or Salesforce under Lead import in that CRM's card in Settings.",
      },
      {
        question: "How do I give leads to my reps?",
        answer:
          "On Leads, select the leads and click Assign, then pick who, the day, an optional time, priority and a note. Or open Hand out work on the Dashboard to give a rep the next free leads as cold calls for today or tomorrow in one step. The Owner and roles with Manage team & roles can hand out work.",
      },
      {
        question: "Can I get my tasks by email?",
        answer: "Yes. SealMe can email you the day's list every morning. Turn it on or off under Customize in the Today card on the Dashboard.",
      },
      {
        question: "How do I see how my team is doing?",
        answer:
          "Managers have a Team today folder on the Dashboard with each rep's calls, meetings and tasks done, and who's behind. The Team page, under Workspace in the sidebar, has more detail and lets you move tasks from one rep to another.",
      },
      {
        question: "How do I turn a lead into a deal?",
        answer:
          "Open the lead and click Convert to deal. SealMe creates the client and the deal and carries over the lead's call history. A sales call made through SealMe does this on its own.",
      },
    ],
  },
  {
    id: "phone-calls",
    label: "Phone calls",
    prospecting: true,
    questions: [
      {
        question: "How do I call a lead through SealMe?",
        answer:
          "First add and verify your phone number once, in Settings under Your phone number; SealMe texts you a code. Then tap Call on a lead or on Next up. SealMe rings your phone, and when you pick up it calls the lead from your number and connects you. It works the same when you tap Call on your computer.",
      },
      {
        question: "What happens after I hang up?",
        answer:
          "SealMe transcribes the call and works out whether it was a cold call or a sales call. A cold call updates the lead with a summary, interest, objections and the next step. A sales call creates the client, the deal and a draft contract for you to review; nothing goes to the client on its own. If HubSpot or Salesforce is connected, the lead's status and a call summary are added there too.",
      },
      {
        question: "Can I call before my number is verified?",
        answer:
          "Yes. Tap Call, then Call SealMe. When SealMe picks up, tap Add call, dial the lead, then Merge. Verifying your number skips those steps.",
      },
      {
        question: "Is every call recorded?",
        answer:
          "No. SealMe follows the recording law of the client's US state, which it reads from the area code. Where one person's consent is enough, the call is recorded. In states that need everyone's consent (CA, CT, DE, FL, IL, MD, MA, MT, NV, NH, PA, WA), or when the state can't be told, the call isn't recorded and you call the client directly. Calls outside the US, to toll-free numbers or to leads with no number aren't recorded either.",
      },
      {
        question: "Why wasn't my call written up?",
        answer:
          "Calls shorter than 30 seconds, voicemails, calls nobody picked up and calls SealMe wasn't allowed to record are skipped. The reason shows next to the call on the Calls page, under History.",
      },
      {
        question: "What is the Calls page for?",
        answer:
          "It lists calls that need a look, for example one SealMe couldn't match to a lead. Pick the lead and click Process, or Discard to delete it. Calls nobody processes are deleted after 24 hours.",
      },
      {
        question: "How long are call recordings kept?",
        answer: "Only until the call is written up or discarded; then the recording is deleted from our phone provider. Calls nobody processes are deleted after 24 hours.",
      },
    ],
  },
  {
    id: "recording",
    label: "Recording calls",
    questions: [
      {
        question: "How does SealMe record a call?",
        answer:
          "Locally, from your computer. It captures your microphone and system audio, so it works with any call platform, Zoom, Meet, Teams, Discord, since nothing joins the call as a visible participant.",
      },
      {
        question: "Does the other person need to install anything?",
        answer: "No. Only you, as the person running the call, need the SealMe desktop app.",
      },
      {
        question: "What happens if my internet drops mid-call?",
        answer:
          "The recording is saved locally and uploaded in the background in short chunks, about once a minute, so a brief connection drop doesn't lose what was already captured.",
      },
      {
        question: "Do I need to tell the other person I'm recording?",
        answer:
          "In most places, yes, the other party needs to know a call is being recorded. Since SealMe no longer joins as a visible bot, that notice is on you to give at the start of the call.",
      },
    ],
  },
  {
    id: "ai-contracts",
    label: "AI and contracts",
    questions: [
      {
        question: "How does SealMe build a contract from a call?",
        answer:
          "AI reads the call transcript and fills in the client, service, price, and other terms into your contract template automatically.",
      },
      {
        question: "What if the AI gets a detail wrong?",
        answer: "Every field can be edited by hand before you send anything. AI fills it in, you confirm it.",
      },
      {
        question: "Can I skip the call and just paste a transcript?",
        answer: "Yes, or you can enter the deal details manually with no call or transcript at all.",
      },
    ],
  },
  {
    id: "approvals",
    label: "Team approvals",
    questions: [
      {
        question: "Who needs to approve a contract before it goes to the client?",
        answer:
          "Whoever you put in the approval chain for that team or deal size. A contract can require one person's approval or several, in order.",
      },
      {
        question: "What if the approver is out of office?",
        answer: "You can assign them a backup teammate who takes over their approvals while they're away.",
      },
    ],
  },
  {
    id: "signing",
    label: "Signing",
    questions: [
      {
        question: "How does the client sign the contract?",
        answer: "Through SealMe's built-in signing flow, or through your own DocuSign account if you connect one in Settings.",
      },
      {
        question: "What happens once a contract is signed?",
        answer:
          "The deal status becomes Signed, your team is notified by email or Slack, and this is also the last time SealMe syncs that deal to your CRM.",
      },
    ],
  },
  {
    id: "crm",
    label: "CRM integrations",
    questions: [
      {
        question: "Does every call sync to Salesforce or HubSpot in real time?",
        answer:
          "No, not while the call is happening. Syncing happens at three points: when the deal is created, when it clears approval, and when it's signed.",
      },
      {
        question: "What happens in the CRM after a contract is signed?",
        answer:
          "Nothing further from SealMe's side. The client becomes a Closed Won opportunity, and any tracking after that point is up to your CRM, not SealMe.",
      },
      {
        question: "Is the sync two-way?",
        answer:
          "Deals go one way, from SealMe to Salesforce or HubSpot, and SealMe stays the source of truth until signing. If Leads is turned on for your workspace, contacts can also come in from your CRM as leads, set up under Lead import in that CRM's card in Settings.",
      },
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    questions: [
      {
        question: "How do I know when a contract is signed?",
        answer: "By email, if you've turned that on in Settings, and by Slack if you've connected a Slack channel.",
      },
      {
        question: "What is auto-remind?",
        answer: "If a client hasn't signed after a few days, SealMe sends them one automatic reminder.",
      },
    ],
  },
  {
    id: "billing",
    label: "Pricing",
    questions: [
      {
        question: "Does SealMe cost anything?",
        answer: "No. SealMe is currently free to use, with no limit on calls or deals, and there's nothing to buy in the app.",
      },
      {
        question: "Is there a limit on this chat?",
        answer: "Each workspace has a monthly allowance of AI chat messages that resets on the 1st. You can always reach a person at ivan@sealme.net.",
      },
    ],
  },
  {
    id: "privacy",
    label: "Security and privacy",
    questions: [
      {
        question: "Is my data used to train AI models?",
        answer:
          "No. Anthropic and Deepgram process call audio and transcripts under contract with SealMe, and they're not permitted to use that data to train their own models unless you explicitly opt in.",
      },
      {
        question: "How long is raw call audio kept?",
        answer:
          "Only as long as needed to transcribe it and extract the deal terms. After that it's deleted or reduced to a text transcript, unless you've configured a longer retention period.",
      },
      {
        question: "Is two-factor authentication available?",
        answer: "Yes, you can turn it on in Settings.",
      },
    ],
  },
  {
    id: "account",
    label: "Account and team",
    questions: [
      {
        question: "How do I invite a teammate?",
        answer: "Go to Settings, Team, and send an invite. They get an email with a link to add their name and set a password; if their address is a Google account they can also sign in with Google on the web. The desktop and iPhone apps use email and password, and Forgot password sets one.",
      },
      {
        question: "Can I restrict who signs up?",
        answer: "Yes, you can restrict invites and sign-ups to a specific email domain in Settings.",
      },
    ],
  },
];
