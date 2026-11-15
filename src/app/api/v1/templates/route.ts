import { prisma } from "@/lib/db";
import { apiGuard, apiJson } from "@/lib/api-auth";

// GET /api/v1/templates: the templates a deal can be started with (POST
// /api/v1/deals takes one's id). kind says which list it's in: proposal or
// contract.
export async function GET(req: Request) {
  const auth = await apiGuard(req);
  if (auth instanceof Response) return auth;

  const templates = await prisma.contractTemplate.findMany({
    where: { workspaceId: auth.workspaceId },
    select: { id: true, name: true, description: true, locked: true, kind: true },
    orderBy: { name: "asc" },
  });
  return apiJson({ data: templates.map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.kind === "proposal" ? "proposal" : "contract", locked: t.locked })) });
}
