#!/usr/bin/env bash
# Global native-client HTTP authentication. Only the keychain holds the token;
# settings hold this absolute command. JSON is consumed by the client, never logged.
set -euo pipefail
client=${1:?claude, codex or desktop}
case $client in claude|codex|desktop) ;; *) exit 2 ;; esac
token=$(/usr/bin/security find-generic-password -a fcpi -s "fcpi mcp $client" -w)
[[ $token =~ ^fcpi_m9[a-z]+_[0-9a-f]{64}$ ]] || exit 2
printf '{"Authorization":"Bearer %s"}\n' "$token"
unset token
