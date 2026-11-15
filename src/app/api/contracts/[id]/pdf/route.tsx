import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { liveContractText, readContractText, showsSignatures } from "@/lib/contract-snapshot";
import { ContractPdfDocument, attachmentDisposition } from "@/lib/contract-pdf";
import { embedTamperEvidentSignature, isPdfSigningConfigured } from "@/lib/pdf-sign";
import { wentOut } from "@/lib/lead-pipeline";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = await prisma.contract.findUnique({
    where: { id },
    include: {
      deal: { include: { client: true, fields: true, workspace: true } },
      template: true,
      signers: { where: { status: "signed" }, orderBy: { order: "asc" } },
    },
  });
  if (!contract) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The client (and anyone else with the link) gets the contract as it was
  // sent. The workspace's own team gets what its contract page shows, which
  // previews the live terms while the contract is being reworked. A
  // proposal stays editable after it went out and its page always shows the
  // terms as they are now, so the team's PDF of it does too.
  const session = await auth();
  const asTeam = session?.user?.workspaceId === contract.deal.workspaceId;
  // Anyone else only gets a document that went out to the client, and not
  // once it's in the trash (its proposal page is gone then too). A draft
  // that never went out isn't theirs to read.
  if (!asTeam && (contract.deal.trashedAt || !wentOut(contract))) {
    return new NextResponse("Not found", { status: 404 });
  }
  const now = new Date();
  const liveProposal = asTeam && contract.deal.kind === "proposal" ? liveContractText(contract) : null;
  const agreement = liveProposal ?? (await readContractText(contract, { asTeam, now }));
  if (!agreement) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Signatures only go under the text that was signed. A contract marked not
  // signed after the client signed keeps their signature on record, but the
  // team's PDF of it carries the reworked terms, so it leaves them all off.
  const withSignatures = !liveProposal && showsSignatures(contract, { asTeam }, now);
  const countersigners = withSignatures
    ? contract.signers.flatMap((s) => (s.signedAt ? [{ name: s.name, role: s.role, signedAt: s.signedAt, signatureImage: s.signatureImage }] : []))
    : [];
  let buffer = await renderToBuffer(
    <ContractPdfDocument
      templateName={agreement.templateName}
      agencyName={agreement.agencyName}
      agencyLogo={contract.deal.workspace.logoImage}
      clientName={agreement.clientName}
      clauses={agreement.clauses}
      signedBy={withSignatures ? contract.signerName : null}
      signedAt={withSignatures ? contract.signedAt : null}
      signatureImage={withSignatures ? contract.signatureImage : null}
      countersigners={countersigners}
      kind={contract.deal.kind}
    />
  );

  // Once everyone has signed, embed a real PKI digital signature into the
  // PDF itself: tamper-evidence any standard reader can verify on its own.
  // A contract still waiting on a counter-signer isn't the final document
  // yet, so it isn't sealed as one. The seal names every signer and is
  // dated when the last of them signed.
  if (withSignatures && contract.status === "signed" && contract.signerName && contract.signedAt && isPdfSigningConfigured()) {
    const signerName = [contract.signerName, ...countersigners.map((s) => s.name)].join(", ");
    const signedAt = new Date(Math.max(contract.signedAt.getTime(), ...countersigners.map((s) => s.signedAt.getTime())));
    try {
      buffer = await embedTamperEvidentSignature(buffer, { signerName, signedAt });
    } catch (err) {
      console.error(`Failed to embed digital signature for contract ${contract.id}`, err);
      // Fall through and serve the unsigned-certificate PDF rather than
      // failing the download entirely — the visual signature/audit trail
      // still stand on their own.
    }
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachmentDisposition(`${agreement.templateName.replace(/\s+/g, "-")}-${contract.deal.client.name.replace(/\s+/g, "-")}.pdf`),
    },
  });
}
