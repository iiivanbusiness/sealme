-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "ghlAccessToken" TEXT,
ADD COLUMN     "ghlEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ghlLocationId" TEXT,
ADD COLUMN     "ghlPipelineId" TEXT,
ADD COLUMN     "ghlStageId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "ghlContactId" TEXT,
ADD COLUMN     "ghlOpportunityId" TEXT;

-- AlterTable
ALTER TABLE "PhoneCall" ADD COLUMN     "ghlNoteId" TEXT;
