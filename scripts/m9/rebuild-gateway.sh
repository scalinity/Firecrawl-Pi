#!/usr/bin/env bash
# Native M9 gateway image: committed source, pinned base/lock, no compilers.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"; . scripts/m1/pi-target.conf
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET")
git diff --quiet HEAD -- . ':(exclude)evidence' || exit 2
sha=$(git rev-parse HEAD)
mkdir -p evidence/M9/work
"${SSH[@]}" "set -e; test \"\$(cat /opt/firecrawl-pi/.fcpi-source-commit)\" = '$sha'; sudo -n docker image tag \"$(sudo -n docker inspect -f '{{.Image}}' fcpi-access-gateway-1)\" \"fcpi/access-gateway:retained-$sha\"; sudo -n docker buildx build --platform linux/arm64 --progress=plain --provenance=false --sbom=false --build-arg FCPI_SOURCE_COMMIT=$sha --load -t fcpi/access-gateway:m9 /opt/firecrawl-pi/services/access; sudo -n docker image inspect fcpi/access-gateway:m9 --format 'image_id={{.Id}} platform={{.Os}}/{{.Architecture}} user={{.Config.User}}'" >evidence/M9/work/image-build.txt 2>&1
node --input-type=module <<'JS'
import fs from 'node:fs';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const transcript=fs.readFileSync('evidence/M9/work/image-build.txt','utf8');const id=transcript.match(/^image_id=(sha256:[0-9a-f]{64}) platform=linux\/arm64 user=3380:3380$/m)?.[1];if(!id)throw Error('No native immutable image');
let compose=fs.readFileSync('deploy/compose.yaml','utf8');const re=/image: fcpi\/access-gateway@sha256:[0-9a-f]{64}/g;if([...compose.matchAll(re)].length!==1)throw Error('Ambiguous image');compose=compose.replace(re,`image: fcpi/access-gateway@${id}`);fs.writeFileSync('deploy/compose.yaml',compose);
const lock=JSON.parse(fs.readFileSync('deploy/versions.lock.json'));lock.images.access_gateway={...lock.images.access_gateway,image_id:id,built_from_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),evidence:'evidence/M9/work/image-build.txt'};lock.host_units['fcpi-incident.service']=createHash('sha256').update(fs.readFileSync('deploy/host/fcpi-incident.service')).digest('hex');lock.host_units['fcpi-incident.timer']=createHash('sha256').update(fs.readFileSync('deploy/host/fcpi-incident.timer')).digest('hex');fs.writeFileSync('deploy/versions.lock.json',JSON.stringify(lock,null,2)+'\n');
JS
git add deploy/compose.yaml deploy/versions.lock.json
git commit -m 'Pin the native M9 incident gateway image'
bash scripts/m1/deploy.sh | sed -E 's#to [^ ]+:/opt/firecrawl-pi#to <pi-ssh-target>:/opt/firecrawl-pi#'
"${SSH[@]}" 'sudo -n bash /opt/firecrawl-pi/deploy/host/fcpi-data-check.sh; sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --no-build --no-deps --wait --wait-timeout 180 access-gateway'
