-- Phase 1.7 — webhook event log.
--
-- Records every inbound webhook before processing, so a payload that fails
-- validation survives for inspection and replay. The unique eventId makes
-- idempotency a database guarantee rather than application logic.
-- See docs/specs/WEBHOOK-CONTRACT.md.

CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "webhookEventId" TEXT;

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE INDEX "WebhookEvent_type_receivedAt_idx" ON "WebhookEvent"("type", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_webhookEventId_key" ON "User"("webhookEventId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

