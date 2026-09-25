#!/usr/bin/env bash
# M0 read-only follow-up: do the planned project paths already exist?
# Runs ON the Pi through `ssh ... bash -s`; writes nothing on the Pi.
set -u
export LC_ALL=C
printf '### probe_time\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '### planned_paths\n'
for d in /opt/firecrawl-pi /srv/firecrawl-pi /etc/firecrawl-pi /var/log/firecrawl-pi /var/lib/docker; do
  if [ -e "$d" ]; then printf '%s=exists\n' "$d"; else printf '%s=absent\n' "$d"; fi
done
printf '### parent_dirs\n'
for d in /opt /srv /etc; do printf '%s entries=%s\n' "$d" "$(ls -A "$d" 2>/dev/null | wc -l)"; done
printf 'opt_names=%s\n' "$(ls -A /opt 2>/dev/null | tr '\n' ' ')"
printf 'srv_names=%s\n' "$(ls -A /srv 2>/dev/null | tr '\n' ' ')"
printf '### filesystem_of_planned_parents\n'
for d in /opt /srv /etc /var/lib; do printf '%s uuid=%s\n' "$d" "$(findmnt -n -o UUID --target "$d")"; done
echo end
