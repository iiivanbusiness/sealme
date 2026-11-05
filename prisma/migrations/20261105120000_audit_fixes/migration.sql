-- DropIndex
DROP INDEX "CalendarEvent_googleEventId_key";

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "allowedEmailDomainVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "domainVerificationToken" TEXT,
ADD COLUMN     "hubspotPipelineId" TEXT,
ADD COLUMN     "hubspotSentStageId" TEXT,
ADD COLUMN     "hubspotSignedStageId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "snapshot" JSONB;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "mergedCrmIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_workspaceId_googleEventId_key" ON "CalendarEvent"("workspaceId", "googleEventId");

