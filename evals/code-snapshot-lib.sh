#!/usr/bin/env bash
# P0-4 (hardening-v0.2-status.md §5 SNAPSHOT-01/API-01) shared helpers for
# eval/security scripts: a code snapshot is created ONLY from an approved
# project workspace — `workspace_id` + `root_relative_path` ('' = the whole
# workspace). The deprecated host-`path` body shape is refused by the kernel
# with 422 (documented as deprecated in api-contracts.md).
#
# Requires: `export DSH_SCHOLAR_SERVICE_TOKEN=...` (every eval kernel runs
# token-configured; the helpers attach x-service-token like the `api()`
# helpers of each script).
#
#   code_snapshot_api <port> <project> <workspace> [relative] [description]
#     POST /v1/projects/{id}/code-snapshots; echoes the response body.
#
#   code_snapshot_seed_workspace <port> <project> <name> <srcdir>
#     POST /v1/projects/{id}/workspaces (kind=code, name=<name>) and uploads
#     every regular file of <srcdir> through the workspace nodes API
#     (relative POSIX paths; dirs are implied). Echoes the workspace_id.
#
# Usage: source "$REPO/evals/code-snapshot-lib.sh"

code_snapshot_api() {
  local PORT="$1" PROJ="$2" WS="$3" REL="${4:-}" DESC="${5:-}"
  curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" \
    -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" \
    -d "$(WS="$WS" REL="$REL" DESC="$DESC" node -e 'process.stdout.write(JSON.stringify({ workspace_id: process.env.WS, root_relative_path: process.env.REL, description: process.env.DESC || undefined }))')"
}

code_snapshot_seed_workspace() {
  local PORT="$1" PROJ="$2" NAME="$3" SRCDIR="$4"
  local WS
  WS=$(curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" \
    -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/workspaces" -d "{\"kind\":\"code\",\"name\":\"$NAME\"}" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).workspace_id)}catch(e){console.log('')}})")
  [ -n "$WS" ] || { echo "code_snapshot_seed_workspace: failed to create workspace $NAME for project $PROJ" >&2; return 1; }
  PORT="$PORT" PROJ="$PROJ" WS="$WS" SRCDIR="$SRCDIR" TOKEN="$DSH_SCHOLAR_SERVICE_TOKEN" node --input-type=module -e '
    const fs = await import("node:fs")
    const path = await import("node:path")
    const base = `http://127.0.0.1:${process.env.PORT}`
    const headers = { "content-type": "application/json", "x-service-token": process.env.TOKEN }
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : [])
    for (const f of walk(process.env.SRCDIR)) {
      const rel = path.relative(process.env.SRCDIR, f).split(path.sep).join("/")
      const content = fs.readFileSync(f, "utf8")
      const r = await fetch(`${base}/v1/projects/${process.env.PROJ}/workspaces/${process.env.WS}/nodes`,
        { method: "POST", headers, body: JSON.stringify({ path: rel, content }) })
      if (!r.ok) throw new Error(`seed ${rel}: HTTP ${r.status}`)
    }
    console.log(process.env.WS)
  '
}
