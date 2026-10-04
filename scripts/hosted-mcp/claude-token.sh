#!/usr/bin/env bash
# Copy directly from the login keychain; never print or put the credential in argv.
set -euo pipefail
/usr/bin/security find-generic-password -a fcpi -s 'fcpi hosted claude-remote' -w | /usr/bin/pbcopy
echo 'Claude bearer token copied to clipboard'
