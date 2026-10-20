// A capture that is a bot interstitial is not a capture of the page. The test is the retrieval service's own
// (services/retrieval/src/quality.mjs), applied to the capture's final URL, so the evaluation and the platform agree on what a
// gate is. A gated capture is rewritten as blocked: its hashes stay, and no consumer counts it as the page (packets, scoring
// and labels read only status "captured").
import { redditGate } from "../../services/retrieval/src/quality.mjs";

export const gated = (c) => redditGate(c.finalUrl ?? "");

export const asBlocked = (c) => ({ ...c, status: "blocked", error: "BLOCKED_PUBLIC_CONTENT: the target served a bot interstitial (Reddit's human-verification gate)" });
