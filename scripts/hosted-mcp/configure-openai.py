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
ssh = ['ssh','-i',conf['PI_SSH_KEY'].replace('$HOME',os.environ['HOME']),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',conf['PI_SSH_TARGET']]
subprocess.run(ssh+['sudo -n python3 -B /opt/firecrawl-pi/scripts/hosted-mcp/pi-configure-openai.py'], input=json.dumps({'key':key,'tunnel':tunnel}).encode(), check=True)
key = None
subprocess.run(ssh+['sudo -n systemctl start fcpi-openai-tunnel.service'], check=True)
print('Tunnel service started; readiness and doctor still need agent verification')
