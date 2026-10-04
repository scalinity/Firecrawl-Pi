#!/usr/bin/env python3
"""Owner enters a dedicated restricted runtime key locally, never through chat."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]
conf = dict(line.split('=', 1) for line in (root/'scripts/m1/pi-target.conf').read_text().splitlines() if line.startswith('PI_'))
tunnel = input('OpenAI tunnel ID: ').strip()
if not re.fullmatch(r'tunnel_[0-9a-f]{32}', tunnel):
    raise SystemExit('Invalid tunnel ID')
key = getpass.getpass('Dedicated restricted tunnel runtime key (hidden): ').strip()
if not re.fullmatch(r'sk-[A-Za-z0-9_-]{20,512}', key):
    raise SystemExit('Invalid runtime key')
remote = r'''
import json,os,pathlib,sys
d=json.load(sys.stdin)
p=pathlib.Path('/etc/firecrawl-pi/hosted-mcp')
key=p/'openai-runtime-key'
if key.exists(): raise SystemExit('runtime key already exists; deliberate rotation required')
with key.open('x') as f: f.write(d['key']+'\n')
os.chmod(key,0o600)
profile=''' + '"""' + '''config_version: 1
control_plane:
  base_url: https://api.openai.com
  tunnel_id: {tunnel}
  api_key: file:/run/credentials/fcpi-openai-tunnel.service/runtime-key
  max_inflight_requests: 1
log:
  level: info
  format: json
health:
  listen_addr: 127.0.0.1:3382
admin_ui:
  open_browser: false
  log_buffer_events: 30
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:3380/mcp
  extra_headers:
    Authorization: file:/run/credentials/fcpi-openai-tunnel.service/mcp-auth
  discovery_extra_headers:
    Authorization: file:/run/credentials/fcpi-openai-tunnel.service/mcp-auth
  startup_wait_timeout: 60s
  max_concurrent_requests: 1
''' + '"""' + '''.format(tunnel=d['tunnel'])
with (p/'openai.yaml').open('x') as f: f.write(profile)
os.chmod(p/'openai.yaml',0o644)
print('Dedicated tunnel key and profile saved on Pi; no secret output')
'''
ssh = ['ssh','-i',conf['PI_SSH_KEY'].replace('$HOME',os.environ['HOME']),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',conf['PI_SSH_TARGET']]
import shlex
subprocess.run(ssh+['sudo -n python3 -B -c '+shlex.quote(remote)], input=json.dumps({'key':key,'tunnel':tunnel}).encode(), check=True)
key = None
subprocess.run(ssh+['sudo -n systemctl start fcpi-openai-tunnel.service'], check=True)
print('Tunnel service started; readiness and doctor still need agent verification')
