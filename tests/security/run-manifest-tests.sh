#!/usr/bin/env bash
# §19.2 P0/P1 blocking tests:
#   - manifest-missing-artifact-rejected   (P0)
#   - stale-runner-fencing-token-rejected  (P1, SCH-JOB-001 / §12.6)
#   - manifest-signature-invalid-rejected  (P1, SCH-MANIFEST-001 / §12.7)
#
# A run manifest that references artifacts which do not exist in the CAS must
# be rejected at job completion (HTTP 422, error code manifest_refs_missing);
# the job must stay running and never be marked succeeded with a dangling
# manifest.
#
# A runner holding a STALE lease (old generation/token after the job was
# recovered and re-claimed) must not be able to complete the job even when its
# owner name still matches: HTTP 409, error code lease_stale.
#
# A run manifest carrying an Ed25519 signature that does not cover its payload
# must be rejected (HTTP 422, manifest_signature_invalid) while the correct
# signature is accepted.
#
# Current kernel: completeJob() -> verifyArtifactRefs() enforces the artifact
# rule; completeJob()/heartbeatJob() enforce lease fencing; verifyRunManifest()
# enforces signature + payload hash + runner key registration.
#
# Usage: bash tests/security/run-manifest-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
PASS=0
FAIL=0

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

cleanup() {
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((20000 + $$ % 400)) $((20500 + $$ % 400)) $((21000 + $$ % 400)); do
    PORT=$port
    nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
    KERNEL_PID=$!
    for _ in $(seq 1 50); do
      curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0
      sleep 0.1
    done
    kill -9 "$KERNEL_PID" 2>/dev/null || true
    wait "$KERNEL_PID" 2>/dev/null || true
    KERNEL_PID=""
  done
  return 1
}

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'
MISSING_SHA="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"manifest\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

say "setup: Ed25519 runner key (signed manifests are the default, RUN-01)"
cat > "$WORK/gen-key.mjs" <<'EOF'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
writeFileSync(process.argv[2], privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
writeFileSync(process.argv[3], publicKey.export({ type: 'spki', format: 'pem' }).toString())
EOF
cat > "$WORK/sign-manifest.mjs" <<'EOF'
// args: jobId projectId metricsArtifact privateKeyPath keyId leaseGeneration mode
import { createHash, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
const [jobId, projectId, metricsArtifact, keyPath, keyId, generation, mode] = process.argv.slice(2)
const canonical = (m) => JSON.stringify(m, Object.keys(m).sort())
const privateKey = readFileSync(keyPath, 'utf8')
const manifest = {
  run_id: `run_shell_${Date.now()}`,
  job_id: jobId,
  project_id: projectId,
  code_commit: 'abc123',
  command: ['echo', 'hello'],
  resources: { gpu: 0, cpu: 1, memory_gb: 1 },
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  exit_code: 0,
  metrics_artifact: metricsArtifact,
}
if (generation !== '' && generation !== '0' && generation !== 'undefined') manifest.lease = { generation: Number(generation) }
const payloadSha256 = createHash('sha256').update(canonical(manifest)).digest('hex')
const signed = { ...manifest, runner_key_id: keyId, payload_sha256: payloadSha256 }
const signature = sign(null, Buffer.from(canonical(signed), 'utf8'), privateKey).toString('base64')
const envelope = { ...signed, signature }
if (mode === 'bad') {
  envelope.exit_code = 1
  const { signature: _s, runner_key_id: _r, payload_sha256: _p, ...payloadOnly } = envelope
  envelope.payload_sha256 = createHash('sha256').update(canonical(payloadOnly)).digest('hex')
}
process.stdout.write(JSON.stringify(envelope))
EOF
node "$WORK/gen-key.mjs" "$WORK/runner-key.pem" "$WORK/runner-key.pub"
KEY_BODY=$(node -e "process.stdout.write(JSON.stringify({ key_id: 'runner-key-shell', public_key_pem: require('fs').readFileSync(process.argv[1], 'utf8') }))" "$WORK/runner-key.pub")
KEY_ID=$(api -X POST "$BASE/v1/runner-keys" -d "$KEY_BODY" | jfield '.key_id')
[[ "$KEY_ID" == "runner-key-shell" ]] || { bad "runner key registration failed (got $KEY_ID)"; exit 1; }
ok "registered Ed25519 runner key runner-key-shell (default requireSignedManifest)"

say "Test: manifest-missing-artifact-rejected"
J1=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"mfa-1","kind":"echo","payload":{"message":"x"}}' | jfield '.job_id')
CLAIM1=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-mfa","lease_ttl_seconds":60,"limit":8}')
CLAIMED=$(printf '%s' "$CLAIM1" | jfield '[0].job_id')
G1=$(printf '%s' "$CLAIM1" | jfield '[0].lease_generation')
T1=$(printf '%s' "$CLAIM1" | jfield '[0].lease_token')
[[ "$CLAIMED" == "$J1" ]] || { echo "claim setup broken: expected $J1 got $CLAIMED"; exit 1; }

SIGNED1=$(node "$WORK/sign-manifest.mjs" "$J1" "$PROJ" "$MISSING_SHA" "$WORK/runner-key.pem" "runner-key-shell" "$G1" good)
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J1/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-mfa\",\"status\":\"succeeded\",\"lease_generation\":$G1,\"lease_token\":\"$T1\",\"run_manifest\":$SIGNED1}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
S1=$(api "$BASE/v1/jobs/$J1" | jfield '.status')
if [[ "$CODE" == "422" && "$ERR_CODE" == "manifest_refs_missing" ]]; then
  ok "completion with missing artifact ref -> 422 ($ERR_CODE); job still '$S1'"
else
  bad "expected 422 manifest_refs_missing, got HTTP $CODE (error=$ERR_CODE), job status '$S1'"
fi

say "Test (control): manifest referencing a REAL artifact is accepted"
META_B64=$(printf '{"metrics":[{"metric":"m","value":0.5,"seed":1}]}' | base64 -w0)
ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"data\",\"content_base64\":\"$META_B64\"}" | jfield '.artifact_id')
J2=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"mfa-2","kind":"echo","payload":{"message":"y"}}' | jfield '.job_id')
CLAIM2=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-mfa","lease_ttl_seconds":60,"limit":8}')
CLAIMED2=$(printf '%s' "$CLAIM2" | jfield '[0].job_id')
G2=$(printf '%s' "$CLAIM2" | jfield '[0].lease_generation')
T2=$(printf '%s' "$CLAIM2" | jfield '[0].lease_token')
[[ "$CLAIMED2" == "$J2" ]] || { echo "claim setup broken: expected $J2 got $CLAIMED2"; exit 1; }
SIGNED2=$(node "$WORK/sign-manifest.mjs" "$J2" "$PROJ" "$ART" "$WORK/runner-key.pem" "runner-key-shell" "$G2" good)
CODE2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs/$J2/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-mfa\",\"status\":\"succeeded\",\"lease_generation\":$G2,\"lease_token\":\"$T2\",\"run_manifest\":$SIGNED2}")
S2=$(api "$BASE/v1/jobs/$J2" | jfield '.status')
if [[ "$CODE2" == "200" && "$S2" == "succeeded" ]]; then
  ok "control: manifest with real artifact -> HTTP 200, job succeeded"
else
  bad "control broken: HTTP $CODE2 status $S2"
fi

say "Test: stale-runner-fencing-token-rejected (SCH-JOB-001, §12.6)"
J3=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fence-1","kind":"echo","payload":{"message":"fence"}}' | jfield '.job_id')
C1=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-fence","lease_ttl_seconds":1,"limit":8}')
G1=$(printf '%s' "$C1" | jfield '[0].lease_generation')
T1=$(printf '%s' "$C1" | jfield '[0].lease_token')
if [[ "$G1" != "1" || -z "$T1" ]]; then
  bad "claim must return lease_generation=1 and a lease_token (got gen=$G1 token=$T1)"
  exit 1
fi
ok "claim returned lease_generation=$G1 + lease_token"
# Let the 1s lease expire, recover it, and let the SAME owner re-claim: the
# old process now holds a stale generation/token pair.
sleep 1.2
REC=$(api -X POST "$BASE/v1/recover/leases" | jfield '.recovered')
[[ "$REC" -ge 1 ]] || { bad "lease recovery expected >=1, got $REC"; exit 1; }
C2=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-fence","lease_ttl_seconds":60,"limit":8}')
G2=$(printf '%s' "$C2" | jfield '[0].lease_generation')
T2=$(printf '%s' "$C2" | jfield '[0].lease_token')
[[ "$G2" == "2" && -n "$T2" && "$T2" != "$T1" ]] || { bad "re-claim must bump generation to 2 and rotate the token (got gen=$G2)"; exit 1; }
# Stale credentials -> 409 lease_stale; job must remain running.
CODE3=$(curl -s -o "$WORK/resp3.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J3/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"status\":\"succeeded\",\"lease_generation\":$G1,\"lease_token\":\"$T1\"}")
ERR3=$(jfield '.error.code' < "$WORK/resp3.json")
S3=$(api "$BASE/v1/jobs/$J3" | jfield '.status')
if [[ "$CODE3" == "409" && "$ERR3" == "lease_stale" && "$S3" == "running" ]]; then
  ok "stale generation/token -> HTTP 409 lease_stale; job still '$S3'"
else
  bad "expected 409 lease_stale, got HTTP $CODE3 (error=$ERR3), job status '$S3'"
fi
# Current credentials -> success.
CODE4=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs/$J3/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"status\":\"succeeded\",\"lease_generation\":$G2,\"lease_token\":\"$T2\"}")
S4=$(api "$BASE/v1/jobs/$J3" | jfield '.status')
if [[ "$CODE4" == "200" && "$S4" == "succeeded" ]]; then
  ok "current generation/token -> HTTP 200, job succeeded"
else
  bad "expected 200 with current token, got HTTP $CODE4 status $S4"
fi

say "Test: manifest-signature-invalid-rejected (SCH-MANIFEST-001, §12.7)"
ART2=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"analysis\",\"content_base64\":\"$META_B64\"}" | jfield '.artifact_id')
J4=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"sig-1","kind":"echo","payload":{"message":"sig"}}' | jfield '.job_id')
C4=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-sig","lease_ttl_seconds":60,"limit":8}')
G4=$(printf '%s' "$C4" | jfield '[0].lease_generation')
T4=$(printf '%s' "$C4" | jfield '[0].lease_token')
BAD=$(node "$WORK/sign-manifest.mjs" "$J4" "$PROJ" "$ART2" "$WORK/runner-key.pem" "runner-key-shell" "$G4" bad)
CODE5=$(curl -s -o "$WORK/resp5.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J4/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-sig\",\"status\":\"succeeded\",\"lease_generation\":$G4,\"lease_token\":\"$T4\",\"run_manifest\":$BAD}")
ERR5=$(jfield '.error.code' < "$WORK/resp5.json")
S5=$(api "$BASE/v1/jobs/$J4" | jfield '.status')
if [[ "$CODE5" == "422" && "$ERR5" == "manifest_signature_invalid" && "$S5" == "running" ]]; then
  ok "forged manifest signature -> HTTP 422 manifest_signature_invalid; job still '$S5'"
else
  bad "expected 422 manifest_signature_invalid, got HTTP $CODE5 (error=$ERR5), job status '$S5'"
fi
GOOD=$(node "$WORK/sign-manifest.mjs" "$J4" "$PROJ" "$ART2" "$WORK/runner-key.pem" "runner-key-shell" "$G4" good)
CODE6=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs/$J4/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-sig\",\"status\":\"succeeded\",\"lease_generation\":$G4,\"lease_token\":\"$T4\",\"run_manifest\":$GOOD}")
S6=$(api "$BASE/v1/jobs/$J4" | jfield '.status')
if [[ "$CODE6" == "200" && "$S6" == "succeeded" ]]; then
  ok "correct manifest signature -> HTTP 200, job succeeded"
else
  bad "expected 200 with valid signature, got HTTP $CODE6 status $S6"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
