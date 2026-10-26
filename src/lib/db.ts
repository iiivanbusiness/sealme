import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { openSecret, sealSecret } from "@/lib/secrets";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });

// Columns that hold secrets: encrypted on the way in, decrypted on the way
// out (see src/lib/secrets.ts), so the rest of the app reads and writes
// them as plain strings.
const SECRET_FIELDS = {
  workspace: [
    "googleRefreshToken",
    "googleAccessToken",
    "ssoClientSecret",
    "slackAccessToken",
    "hubspotAccessToken",
    "hubspotWebhookSecret",
    "ghlAccessToken",
    "docusignAccessToken",
    "docusignRefreshToken",
    "salesforceAccessToken",
    "salesforceRefreshToken",
  ],
  user: ["twoFactorSecret"],
  webhookEndpoint: ["secret"],
} as const;

type SecretModel = keyof typeof SECRET_FIELDS;

function sealData(model: SecretModel, data: unknown): unknown {
  if (Array.isArray(data)) return data.map((d) => sealData(model, d));
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const field of SECRET_FIELDS[model]) {
    const v = out[field];
    if (typeof v === "string") out[field] = sealSecret(v);
    else if (v && typeof v === "object" && typeof (v as { set?: unknown }).set === "string") out[field] = { set: sealSecret((v as { set: string }).set) };
  }
  return out;
}

const WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);

function sealArgs(model: SecretModel, operation: string, args: Record<string, unknown>) {
  if (!WRITES.has(operation)) return args;
  const next = { ...args };
  if ("data" in next) next.data = sealData(model, next.data);
  if (operation === "upsert") {
    next.create = sealData(model, next.create);
    next.update = sealData(model, next.update);
  }
  return next;
}

const open = (v: string | null) => (v === null ? null : openSecret(v));

const secretColumns = Prisma.defineExtension({
  name: "secret-columns",
  query: {
    workspace: { $allOperations: ({ operation, args, query }) => query(sealArgs("workspace", operation, args as Record<string, unknown>) as typeof args) },
    user: { $allOperations: ({ operation, args, query }) => query(sealArgs("user", operation, args as Record<string, unknown>) as typeof args) },
    webhookEndpoint: { $allOperations: ({ operation, args, query }) => query(sealArgs("webhookEndpoint", operation, args as Record<string, unknown>) as typeof args) },
  },
  result: {
    workspace: {
      googleRefreshToken: { needs: { googleRefreshToken: true }, compute: (w) => open(w.googleRefreshToken) },
      googleAccessToken: { needs: { googleAccessToken: true }, compute: (w) => open(w.googleAccessToken) },
      ssoClientSecret: { needs: { ssoClientSecret: true }, compute: (w) => open(w.ssoClientSecret) },
      slackAccessToken: { needs: { slackAccessToken: true }, compute: (w) => open(w.slackAccessToken) },
      hubspotAccessToken: { needs: { hubspotAccessToken: true }, compute: (w) => open(w.hubspotAccessToken) },
      hubspotWebhookSecret: { needs: { hubspotWebhookSecret: true }, compute: (w) => open(w.hubspotWebhookSecret) },
      docusignAccessToken: { needs: { docusignAccessToken: true }, compute: (w) => open(w.docusignAccessToken) },
      docusignRefreshToken: { needs: { docusignRefreshToken: true }, compute: (w) => open(w.docusignRefreshToken) },
      salesforceAccessToken: { needs: { salesforceAccessToken: true }, compute: (w) => open(w.salesforceAccessToken) },
      salesforceRefreshToken: { needs: { salesforceRefreshToken: true }, compute: (w) => open(w.salesforceRefreshToken) },
    },
    user: {
      twoFactorSecret: { needs: { twoFactorSecret: true }, compute: (u) => open(u.twoFactorSecret) },
    },
    webhookEndpoint: {
      // Not nullable: an unreadable secret signs nothing rather than crashing.
      secret: { needs: { secret: true }, compute: (e) => openSecret(e.secret) ?? "" },
    },
  },
});

function createClient() {
  return new PrismaClient({ adapter }).$extends(secretColumns);
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createClient> };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
