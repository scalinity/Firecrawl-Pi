#!/usr/bin/env bash
# Copy directly from the login keychain; never print or put the credential in argv.
set -euo pipefail
{ printf 'Bearer '; /usr/bin/security find-generic-password -a fcpi -s 'fcpi hosted claude-remote' -w; } | tr -d '\r\n' | /usr/bin/pbcopy
echo 'Claude Authorization value copied to clipboard'
