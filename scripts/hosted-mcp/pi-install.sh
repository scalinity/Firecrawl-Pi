#!/usr/bin/env bash
# Run only from the committed archive on the Pi. Does not enable public Funnel.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
[ "$(id -u)" = 0 ] || { echo 'root required' >&2; exit 2; }
cd /opt/firecrawl-pi
[ "$(uname -m)" = aarch64 ] || exit 2
H=/etc/firecrawl-pi/hosted-mcp
install -d -m 0755 "$H"
for pair in 'chatgpttunnel chatgpt-tunnel' 'clauderemote claude-remote'; do
  read -r label principal <<<"$pair"
  if ! test -f "/etc/firecrawl-pi/secrets/clients/$label.token"; then
    bash scripts/m3/pi-client-token.sh create "$label" "$principal" read,scrape,map,search,crawl,batch,extract
  fi
done
python3 -B - <<'PY'
import hashlib,json,os,pathlib,subprocess,tempfile
p=pathlib.Path('/etc/firecrawl-pi/hosted-mcp')
state=json.loads(subprocess.check_output(['tailscale','status','--json']))
host=state['Self']['DNSName'].rstrip('.')+':443'
token=pathlib.Path('/etc/firecrawl-pi/secrets/clients/clauderemote.token').read_text().strip()
cfg={'host':host,'token_sha256':hashlib.sha256(token.encode()).hexdigest()}
target=p/'claude.json'
if target.exists() and json.loads(target.read_text())!=cfg:
    previous=json.loads(target.read_text())
    expected_previous={**cfg,'host':host.removesuffix(':443')+':10000'}
    if previous!=expected_previous: raise SystemExit('existing Claude configuration differs')
    with tempfile.NamedTemporaryFile(mode='w',dir=p,delete=False) as f:
        json.dump(cfg,f);f.write('\n');f.flush();os.fsync(f.fileno())
        staged=f.name
    os.chmod(staged,0o644);os.replace(staged,target)
if not target.exists():
    with target.open('x') as f: json.dump(cfg,f); f.write('\n')
    os.chmod(target,0o644)
token=pathlib.Path('/etc/firecrawl-pi/secrets/clients/chatgpttunnel.token').read_text().strip()
target=p/'openai-mcp-auth'
auth='Bearer '+token
if target.exists() and target.read_text().strip()!=auth: raise SystemExit('existing OpenAI MCP credential differs')
if not target.exists():
    with target.open('x') as f: f.write(auth+'\n')
    os.chmod(target,0o600)
print('dedicated hosted credentials configured; no secret output')
PY
V=/opt/fcpi-tunnel/v0.0.15
if ! test -x "$V/tunnel-client"; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://github.com/openai/tunnel-client/releases/download/v0.0.15/tunnel-client-v0.0.15-linux-arm64.zip -o "$tmp/client.zip"
  printf '%s  %s\n' c51bfd883fc22e3445494a03c0179875176564bde470661b308fd83af5d01abb "$tmp/client.zip" | sha256sum --check --status
  install -d -m 0755 "$V"
  python3 -B - "$tmp/client.zip" "$V" <<'PY'
import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as z:
    for item in z.infolist():
        path=pathlib.PurePosixPath(item.filename)
        if path.is_absolute() or '..' in path.parts or (item.external_attr >> 16)&0o170000==0o120000:
            raise SystemExit('unsafe release archive')
    z.extractall(root)
PY
  chmod 0755 "$V/tunnel-client"
fi
"$V/tunnel-client" --version
install -m 0644 deploy/host/fcpi-hosted-mcp.service /etc/systemd/system/
install -m 0644 deploy/host/fcpi-openai-tunnel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fcpi-hosted-mcp.service
systemctl enable fcpi-openai-tunnel.service
echo 'Claude loopback ingress started; OpenAI tunnel awaits dedicated runtime key and tunnel identity; Funnel unchanged'
