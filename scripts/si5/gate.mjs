// A capture that is a bot interstitial is not a capture of the page. The test is the retrieval service's own
// (services/retrieval/src/quality.mjs): the gate's redirect parameters on the capture's final URL when the pool URL did not
// carry them, or the gate's own title, so the evaluation and the platform agree on what the Reddit gate is. A gated capture
// is rewritten as blocked: its hashes stay, packets and scoring read only status "captured" so they no longer count it as the
// page, and labels.mjs reads "blocked" to drop the grade of a document that was judged on one.
import { redditGate, redditGateTitle } from "../../services/retrieval/src/quality.mjs";

export const gated = (c) => (redditGate(c.finalUrl ?? "") && !redditGate(c.url ?? "")) || redditGateTitle(c.title);

export const asBlocked = (c) => ({ ...c, status: "blocked", error: "BLOCKED_PUBLIC_CONTENT: the target served a bot interstitial (Reddit's human-verification gate)" });
