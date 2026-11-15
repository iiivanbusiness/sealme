// Where Start call opens with the person filled in: their lead, or the
// email and name a meeting gives (only the ones that are set). desktop: in
// the desktop app it opens on recording live (mode=local), in a browser on
// upload or paste. Plain, so both the server and the browser can build it.
export function startCallHref({ leadId, who, name }: { leadId?: string; who?: string; name?: string }, desktop: boolean): string {
  const params = new URLSearchParams();
  if (leadId) params.set("lead", leadId);
  else {
    if (who) params.set("who", who);
    if (name) params.set("name", name);
  }
  if (desktop) params.set("mode", "local");
  return params.size ? `/deals/new?${params.toString()}` : "/deals/new";
}
