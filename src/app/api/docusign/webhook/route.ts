import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncDocusignContract } from "@/lib/docusign-sync";
import { reportError } from "@/lib/error-report";

type EnvelopeEvent = { event?: string; envelopeId?: string; data?: { envelopeId?: string } };

// DocuSign calls this when an envelope SealMe sent is completed, declined
// or voided (the envelope carries this URL, see sendDocusignEnvelope).
// Nothing in the body is trusted: it only names the envelope, and SealMe
// asks DocuSign with that workspace's own connection where it really
// stands before changing anything. So a forged call can at most trigger a
// lookup. Always 200 for envelopes SealMe doesn't know, or DocuSign
// retries.
export async function POST(req: Request) {
  const raw = await req.text();
  let payload: EnvelopeEvent;
  try {
    payload = JSON.parse(raw) as EnvelopeEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const envelopeId = payload.data?.envelopeId ?? payload.envelopeId;
  if (!envelopeId || !/^[0-9a-f-]{36}$/i.test(envelopeId)) return NextResponse.json({ ok: true, skipped: true });

  const contract = await prisma.contract.findFirst({ where: { docusignEnvelopeId: envelopeId }, select: { id: true } });
  if (!contract) return NextResponse.json({ ok: true, skipped: true });

  try {
    const signed = await syncDocusignContract(contract.id);
    return NextResponse.json({ ok: true, signed });
  } catch (err) {
    await reportError(err, "DocuSign webhook", { contractId: contract.id });
    // A failed lookup is retried by DocuSign, and by the daily check.
    return NextResponse.json({ error: "Couldn't confirm with DocuSign" }, { status: 502 });
  }
}
