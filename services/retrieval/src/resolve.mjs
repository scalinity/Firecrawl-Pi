// Name resolution for connections (FIRECRAWL_PI_SPEC.md §20.2). A target name is resolved once
// per connection, every answer must be a public address, and the connection is then made to
// exactly the first answer: the socket's lookup function returns only that address and the
// connected peer is compared with it, so nothing re-resolves the name between the check and the
// connect (DNS rebinding).
//   - public names: the configured resolver (the host's DNS through the egress bridge);
//   - fixture names: Docker's resolver on the fixture network, and every answer must lie in the
//     fixture's own subnet (the deployment-controlled exception).
import { Resolver, lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { classifyAddress, Denied } from "./ssrf.mjs";

export function makePublicResolver({ server, timeoutMs = 3000 }) {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  if (server) r.setServers([server]);
  return (host) => r.resolve4(host);
}

const DNS_ERRORS = new Set(["ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "ECONNREFUSED", "EBADRESP", "ENONAME"]);

// Returns the one address the connection may use.
export async function resolveTarget(target, { resolvePublic, policy, lookupFixture = defaultFixtureLookup }) {
  if (target.literal) return target.host;
  if (target.fixture) {
    const cidr = target.fixture.cidr.split("/");
    const within = new BlockList();
    within.addSubnet(cidr[0], Number(cidr[1]), "ipv4");
    const answers = await lookupFixture(target.host).catch(() => []);
    if (answers.length === 0) throw new Denied("DNS_FAILURE", `fixture ${target.host} does not resolve`);
    const outside = answers.find((a) => !within.check(a, "ipv4"));
    if (outside) throw new Denied("SSRF_DENIED", `fixture ${target.host} resolves to ${outside}, outside ${target.fixture.cidr}`);
    return answers[0];
  }
  let answers;
  try {
    answers = await resolvePublic(target.host);
  } catch (e) {
    throw new Denied("DNS_FAILURE", `${target.host}: ${DNS_ERRORS.has(e.code) ? e.code : "resolution failed"}`);
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new Denied("DNS_FAILURE", `${target.host}: no IPv4 address`);
  // Every answer is checked, not only the one used: a name that mixes public and private answers
  // is refused, so a later answer rotation cannot reach the private one.
  for (const a of answers) {
    const why = classifyAddress(a, policy.localCidrs);
    if (why !== "public") throw new Denied("SSRF_DENIED", `${target.host} resolves to a ${why} address`);
  }
  return answers[0];
}

async function defaultFixtureLookup(host) {
  return (await lookup(host, { all: true, family: 4 })).map((a) => a.address);
}

// A net/tls lookup function that answers only with the pinned address, in both callback forms
// Node uses (a single address, or all addresses when autoSelectFamily asks for them).
export function pinnedLookup(address) {
  return (_host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (options && typeof options === "object" && options.all) cb(null, [{ address, family: 4 }]);
    else cb(null, address, 4);
  };
}
