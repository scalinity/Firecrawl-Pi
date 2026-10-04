"""Read current SearXNG engine errors; omit queries and content."""
import collections
import datetime
import json
import re
import subprocess

container = subprocess.check_output([
    'docker', 'ps', '-q',
    '--filter', 'label=com.docker.compose.project=fcpi',
    '--filter', 'label=com.docker.compose.service=searxng',
], text=True).strip()
assert container
raw = subprocess.run([
    'docker', 'logs', container,
], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
events = []
last_timestamp = None
last_engine = None
for line in raw.splitlines():
    stamp = re.search(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', line)
    engine = re.search(r'\b(duckduckgo|brave)\b', line)
    if stamp:
        last_timestamp = stamp[0]
    if engine:
        last_engine = engine[1]
    if 'disconnected' in line.lower():
        events.append({'log_timestamp': last_timestamp, 'engine': last_engine,
                       'classification': 'disconnect diagnostic',
                       'attribution': 'preceding timestamp and engine log context'})
print(json.dumps({
    'schema': 'fcpi.hosted-search-observation/v1',
    'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'positive_log_lines': len(raw.splitlines()),
    'scope_window': 'Whole current SearXNG container log; application timestamps retained without timezone inference',
    'error_counts': dict(collections.Counter(x['engine'] for x in events)),
    'diagnostic_term_counts': {term: raw.lower().count(term) for term in ['duckduckgo', 'brave', 'error', 'disconnected', 'retry']},
    'events': events,
    'state': 'DISCONNECT_DIAGNOSTICS_OBSERVED' if events else 'NOT_OBSERVED',
    'scope': 'Existing search backend; read only. No engine configuration changed. This does not quantify relevance or establish novelty evidence.',
}, indent=2))
