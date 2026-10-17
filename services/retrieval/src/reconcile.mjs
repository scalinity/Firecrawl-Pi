// Proxy usage reconciliation (FIRECRAWL_PI_SPEC.md §10.3, §28.3): locally measured bytes are estimates until the
// provider's own usage report confirms them. For one provider and one UTC day this reads the provider-reported
// bytes (upload plus download) and compares them with what the ledger measured:
//   - more reported than measured: the difference is a real charge, recorded as a settled "reconcile" row at the
//     rate card's price, whatever the cap (a charge already incurred is never hidden by a cap). Bytes an earlier
//     reconciliation charged count as measured, so running again charges only what the report added since (review C1);
//   - either way, each UNCERTAIN reservation of that day is settled at the bytes it measured, since the report
//     now covers its unknown part; a charge is never lowered below what was measured.
// The report must cover this deployment alone: Decodo's traffic report is the account's, with no per-user filter in its
// documented request, so a provider is reconciled only when its policy entry declares usageDedicated (an account this
// deployment alone uses); otherwise other traffic on the account would be charged here (review W13).
import { randomUUID } from "node:crypto";
import { providerRequest, readCredential, ProviderError } from "./provider.mjs";
import { proxyCost, rateCardFor, paidTotalDayCap } from "./budget.mjs";
import { Denied } from "./ssrf.mjs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The provider-reported bytes for one UTC day. Decodo: POST /api/v2/statistics/traffic with the API key as the
// Authorization value, answered in bytes (metadata.total_rx_tx; help.decodo.com "Usage Statistics", checked
// 2026-09-26). The fixture proxy answers GET ?day= with { rx_tx_bytes }.
export async function providerDayBytes({ provider, providersDir, day, getPolicy, resolvePublic, lookupFixture }) {
  const u = new URL(provider.usageUrl);
  const common = { baseUrl: u.origin, timeoutMs: 20000, maxBytes: 1048576, getPolicy, resolvePublic, lookupFixture };
  let r;
  if (provider.usageCredential === null) {
    r = await providerRequest({ ...common, path: `${u.pathname}?day=${day}`, method: "GET", headers: { accept: "application/json" } });
    if (r.status !== 200) throw new ProviderError("PROVIDER_ERROR", `the usage report answered ${r.status}`, { sent: true, status: r.status });
    const n = JSON.parse(r.body.toString("utf8")).rx_tx_bytes;
    if (!Number.isSafeInteger(n) || n < 0) throw new ProviderError("PROVIDER_ERROR", "the usage report holds no byte count", { sent: true });
    return n;
  }
  const key = readCredential(providersDir, provider.usageCredential);
  if (!key) throw new ProviderError("BLOCKED_CREDENTIAL", `the usage report's credential ${provider.usageCredential} is absent`, { sent: false });
  const body = Buffer.from(JSON.stringify({ proxyType: "residential_proxies", startDate: `${day} 00:00:00`, endDate: `${day} 23:59:59`, groupBy: "day", limit: 500, page: 1, sortBy: "grouping_key", sortOrder: "asc" }));
  r = await providerRequest({ ...common, path: u.pathname, method: "POST", body, headers: { authorization: key, "content-type": "application/json", accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new ProviderError("PROVIDER_AUTH_FAILED", `the usage report refused its credential (${r.status})`, { sent: true, status: r.status });
  if (r.status !== 200) throw new ProviderError("PROVIDER_ERROR", `the usage report answered ${r.status}`, { sent: true, status: r.status });
  const n = Number(JSON.parse(r.body.toString("utf8"))?.metadata?.total_rx_tx);
  if (!Number.isSafeInteger(n) || n < 0) throw new ProviderError("PROVIDER_ERROR", "the usage report holds no total_rx_tx", { sent: true });
  return n;
}

export async function reconcileDay({ store, getBudget, providersDir, providerName, day, getPolicy, resolvePublic, lookupFixture, log }) {
  if (!DAY.test(day)) throw new Error("day must be YYYY-MM-DD");
  const budget = getBudget(), provider = budget.providers[providerName];
  if (!provider || provider.kind !== "proxy" || !provider.usageUrl) throw new Error(`${providerName} is not a proxy with a usage report`);
  if (provider.usageDedicated !== true) throw new Denied("RECONCILE_SCOPE_UNKNOWN", `${providerName}'s usage report covers its whole account; reconcile only an account this deployment alone uses (usageDedicated in the budget policy)`);
  // A proxy row still RESERVED has bytes the report may already hold and the ledger does not: reconciling now would
  // charge them here and again when the row settles, so the day waits until nothing is in flight.
  const before = await store.proxyDay(providerName, day);
  if (before.reserved > 0) throw new Denied("RECONCILE_IN_FLIGHT", `${before.reserved} proxy reservation(s) of ${day} are still in flight; reconcile once they settle`, { retryable: true });
  const reported = await providerDayBytes({ provider, providersDir, day, getPolicy, resolvePublic, lookupFixture });
  const local = await store.proxyDay(providerName, day);
  if (local.reserved > 0) throw new Denied("RECONCILE_IN_FLIGHT", `a proxy reservation of ${day} opened while the report was read; reconcile once it settles`, { retryable: true });
  const measured = local.settledBytes + local.uncertainBytes + local.adjustedBytes;
  let adjustment = 0;
  if (reported > measured) {
    // The subject whose card prices the difference: the provider's first listed subject in a paid category if it
    // is paid, so the charge lands where the provider's spend is capped.
    const [subject, s] = Object.entries(budget.proxies).find(([, x]) => x.provider === providerName);
    const card = rateCardFor(budget, subject, new Date(`${day}T12:00:00Z`));
    if (!card) throw new Error(`no rate card for ${subject} on ${day}`);
    adjustment = proxyCost(card, reported - measured);
    if (adjustment > 0) await store.recordAdjustment({ id: randomUUID(), callKey: `reconcile:${providerName}:${day}:${randomUUID()}`, category: s.category, periods: Object.keys(budget.categories[s.category].caps), provider: providerName, subject,
      rateCard: card.id, amount: adjustment, day, paidTotal: provider.paid && paidTotalDayCap(budget) !== null, usage: { bytes: reported - measured, reportedBytes: reported, measuredBytes: measured } });
  }
  const settledUncertain = await store.settleUncertainProxy(providerName, day, (bytes, subject) => {
    const card = rateCardFor(budget, subject, new Date(`${day}T12:00:00Z`));
    return card ? proxyCost(card, bytes) : null;
  });
  await store.recordReconciliation({ provider: providerName, day, localBytes: measured, providerBytes: reported, adjustment, settledUncertain,
    detail: reported >= measured ? "provider report at or above the local measurement" : "provider report below the local measurement; the measured charge stands" });
  log({ event: "proxy_reconciled", provider: providerName, day, local_bytes: measured, provider_bytes: reported, adjustment_micro_usd: adjustment, uncertain_settled: settledUncertain });
  return { provider: providerName, day, localBytes: measured, providerBytes: reported, adjustmentMicroUsd: adjustment, uncertainSettled: settledUncertain };
}
