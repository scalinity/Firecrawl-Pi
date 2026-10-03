# The restore test's isolated copy (scripts/ops/restore-test.sh), as a jq module so the script and its golden test
# (tests/contracts/m8-restore-compose.test.mjs) run one transformation:
#   jq -L scripts/ops --arg R <copy dir> 'include "restore"; compose($R)'    the copy's Compose file, from the restored
#                                                                             tree's rendered one
#   jq -L scripts/ops 'include "restore"; walk(if type == "string" then move else . end)'   a policy's addresses moved

# The services the copy runs: the data services, the core, the gateways, the retrieval service and the M1 fixture. The
# browser, SearXNG and the M2-M7 fixtures are left out.
def kept: ["nuq-postgres", "redis", "rabbitmq", "firecrawl-core", "access-gateway", "mcp-gateway", "retrieval-service", "fixture"];

# Each project /24 10.231.N moves to 10.231.(200+N): inside the range the retrieval service's policy requires of a
# fixture network, and apart from production's.
def move: gsub("10\\.231\\.(?<n>[0-9]{1,2})\\."; "10.231.\((.n | tonumber) + 200).");

# Every production path the file names moves under the copy's directory $R.
def fix($R): if type == "string" then
    gsub("/srv/firecrawl-pi/data/"; $R + "/data/") | gsub("/opt/firecrawl-pi/"; $R + "/fs/opt/firecrawl-pi/")
  | gsub("/etc/firecrawl-pi/secrets"; $R + "/secrets/secrets") | gsub("/etc/firecrawl-pi/"; $R + "/fs/etc/firecrawl-pi/")
  | gsub("/run/firecrawl-pi/admission"; $R + "/admission") | move
  | gsub("/var/lib/firecrawl-pi/"; $R + "/fs/var/lib/firecrawl-pi/")
  elif type == "object" then map_values(fix($R)) elif type == "array" then map(fix($R)) else . end;

# The copy: project fcpi-restore; no published port; no egress network; every network internal and renamed fcpi_r_*
# (bridges fcpi-r-*, which NetworkManager leaves alone); webhook delivery suppressed and paid dispatch off; no restart
# policy, so a host that resets during the test never revives the copy at boot (its EXIT trap did not run); every
# container labelled fcpi.transient=restore-test.
def compose($R): kept as $keep
  | fix($R) | .name = "fcpi-restore"
  | .services |= with_entries(select(.key as $k | $keep | index($k)))
  | .services |= map_values(del(.ports) | .restart = "no" | .labels = ((.labels // {}) + {"fcpi.transient": "restore-test"})
      | (if .networks then .networks |= del(.egress) else . end)
      | (if .depends_on then .depends_on |= with_entries(select(.key as $k | $keep | index($k))) else . end))
  | .services["retrieval-service"].environment += {PI_WEBHOOK_DELIVERY: "suppressed", PI_PAID_DISPATCH_ENABLED: "false"}
  | .services["firecrawl-core"].environment += {DISABLE_WEBHOOK_DELIVERY: "true"}
  # Restored approvals and incident agents never control production or consume
  # an old owner action. Their state is retained for inspection only.
  | .services["access-gateway"].environment |= with_entries(select(.key | startswith("PI_INCIDENT_") | not))
  | .services["access-gateway"].volumes |= map(select((.target | startswith("/srv/incidents")) | not))
  | .networks |= (del(.egress) | map_values(.name |= sub("^fcpi_"; "fcpi_r_") | .internal = true | .labels = {"fcpi.transient": "restore-test"}
      | .driver_opts["com.docker.network.bridge.name"] |= sub("^fcpi-"; "fcpi-r-") | .driver_opts["com.docker.network.bridge.gateway_mode_ipv4"] = "isolated"));

# Every host path the copy's file names (bind sources, secret, config and env files) that is not under $R: none, or the
# copy would share production's state.
def outside($R): [ (.services[] | (.volumes[]? | select(.type == "bind") | .source), (.env_file[]? | if type == "object" then .path else . end)),
    (.secrets // {} | .[] | .file // empty), (.configs // {} | .[] | .file // empty) ]
  | map(select(startswith($R + "/") | not)) | unique;
