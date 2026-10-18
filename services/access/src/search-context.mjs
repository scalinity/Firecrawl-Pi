// Search intelligence (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.2): the search's trusted context, built here and sent as
// the core's allowlisted request headers (upstream.mjs): this request's id, a new logical search id, the principal's owner tag
// (never the principal's name or token) and the absolute deadline the caller's timeout gives. Only a search carries them.
import { randomUUID } from "node:crypto";
import { ownerTag } from "./auth.mjs";

export function trustedSearchHeaders(route, ctx, body, now = Date.now) {
  if (route.id !== "search") return null;
  return { "x-fcpi-search-request-id": ctx.id, "x-fcpi-search-id": randomUUID(), "x-fcpi-search-owner": ownerTag(ctx.client.principal),
    "x-fcpi-search-deadline-ms": String(now() + (body.timeout ?? 60000)) };
}
