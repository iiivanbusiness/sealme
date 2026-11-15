-- The redesign (plan of 2026-11-11): every call is a call on a lead, each
-- call can carry a proposal and a contract, leads move through stages by
-- themselves, and a desktop recording can start without a deal.
-- Additive only: new columns are nullable or have defaults, and the two
-- LocalCaptureToken columns that become optional are only ever left empty
-- by the new code, so the deployed app keeps working on this database.


-- AlterTable
ALTER TABLE "ContractTemplate" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'contract';

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'contract',
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "phoneCallId" TEXT,
ADD COLUMN     "sourceDealId" TEXT;

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "attendeeEmail" TEXT;

-- AlterTable
ALTER TABLE "LocalCaptureToken" ADD COLUMN     "phoneCallId" TEXT,
ALTER COLUMN "dealId" DROP NOT NULL,
ALTER COLUMN "callId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "clientAt" TIMESTAMP(3),
ADD COLUMN     "isClient" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "pipelineStage" TEXT NOT NULL DEFAULT 'new';

-- Backfill: a lead's last activity so far is its last call, or when it
-- was added. Leads added from now on start at the moment they're added.
UPDATE "Lead" SET "lastActivityAt" = COALESCE("lastContactedAt", "createdAt");

-- AlterTable
ALTER TABLE "PhoneCall" ADD COLUMN     "wantsContract" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wantsProposal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CallIntent" ADD COLUMN     "wantsContract" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wantsProposal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Deal_leadId_idx" ON "Deal"("leadId");

-- CreateIndex
CREATE INDEX "Deal_phoneCallId_idx" ON "Deal"("phoneCallId");

-- CreateIndex
CREATE INDEX "CalendarEvent_workspaceId_startTime_idx" ON "CalendarEvent"("workspaceId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "LocalCaptureToken_phoneCallId_key" ON "LocalCaptureToken"("phoneCallId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_pipelineStage_idx" ON "Lead"("workspaceId", "pipelineStage");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_isClient_idx" ON "Lead"("workspaceId", "isClient");

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_phoneCallId_fkey" FOREIGN KEY ("phoneCallId") REFERENCES "PhoneCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_sourceDealId_fkey" FOREIGN KEY ("sourceDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalCaptureToken" ADD CONSTRAINT "LocalCaptureToken_phoneCallId_fkey" FOREIGN KEY ("phoneCallId") REFERENCES "PhoneCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

