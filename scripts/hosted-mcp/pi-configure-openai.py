#!/usr/bin/env python3
"""Publish matching OpenAI credentials/configuration atomically; safe to resume."""
import json
import os
from pathlib import Path
import re
import tempfile


def publish(path, content, mode):
    if path.exists() or path.is_symlink():
        if path.is_symlink() or path.read_text() != content or path.stat().st_mode & 0o777 != mode:
            raise ValueError('existing tunnel configuration differs; deliberate rotation required')
        return
    fd, name = tempfile.mkstemp(prefix='.openai-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.link(name, path)
    finally:
        os.unlink(name)


def provision(directory, data):
    if set(data) != {'key', 'tunnel'} or not re.fullmatch(r'tunnel_[0-9a-f]{32}', data['tunnel']) or not re.fullmatch(r'sk-[A-Za-z0-9_-]{20,512}', data['key']):
        raise ValueError('invalid tunnel identity or runtime key')
    profile = '''config_version: 1
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
'''.format(tunnel=data['tunnel'])
    key, cfg = directory/'openai-runtime-key', directory/'openai.yaml'
    # Check both before publishing either, so a conflicting profile cannot leave a key.
    for path, expected in [(key, data['key']+'\n'), (cfg, profile)]:
        if (path.exists() or path.is_symlink()) and (path.is_symlink() or path.read_text() != expected):
            raise ValueError('existing tunnel configuration differs; deliberate rotation required')
    publish(key, data['key']+'\n', 0o600)
    publish(cfg, profile, 0o644)


if __name__ == '__main__':
    import sys
    if os.getuid() != 0:
        raise SystemExit('root required')
    provision(Path('/etc/firecrawl-pi/hosted-mcp'), json.load(sys.stdin))
    print('Dedicated tunnel key and profile saved on Pi; no secret output')
