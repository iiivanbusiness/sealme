import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { readContractText } from "@/lib/contract-snapshot";
import { ContractPdfDocument, attachmentDisposition } from "@/lib/contract-pdf";
import { embedTamperEvidentSignature, isPdfSigningConfigured } from "@/lib/pdf-sign";

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
  // previews the live terms while the contract is being reworked.
  const session = await auth();
  const agreement = await readContractText(contract, { asTeam: session?.user?.workspaceId === contract.deal.workspaceId });
  if (!agreement) {
    return new NextResponse("Not found", { status: 404 });
  }

  const countersigners = contract.signers.flatMap((s) => (s.signedAt ? [{ name: s.name, role: s.role, signedAt: s.signedAt, signatureImage: s.signatureImage }] : []));
  let buffer = await renderToBuffer(
    <ContractPdfDocument
      templateName={agreement.templateName}
      agencyName={agreement.agencyName}
      agencyLogo={contract.deal.workspace.logoImage}
      clientName={agreement.clientName}
      clauses={agreement.clauses}
      signedBy={contract.signerName}
      signedAt={contract.signedAt}
      signatureImage={contract.signatureImage}
      countersigners={countersigners}
    />
  );

  // Once everyone has signed, embed a real PKI digital signature into the
  // PDF itself: tamper-evidence any standard reader can verify on its own.
  // A contract still waiting on a counter-signer isn't the final document
  // yet, so it isn't sealed as one. The seal names every signer and is
  // dated when the last of them signed.
  if (contract.status === "signed" && contract.signerName && contract.signedAt && isPdfSigningConfigured()) {
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
