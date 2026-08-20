#!/usr/bin/env bash
# Shared setup for positive confirmatory/formal security fixtures.
#
# Callers must define REPO, WORK, BASE, DSH_SCHOLAR_SERVICE_TOKEN, api(), and
# jfield().  The helper deliberately leaves project lifecycle and baseline
# submission to each scenario: baseline-runs remains the sole atomic baseline
# handoff, while only confirmatory/formal jobs receive a Protocol pin.

formal_fixture_init_target_identity() {
  local work_root="$1"
  local token="$2"

  if [ "${#token}" -lt 32 ]; then
    printf 'formal fixture target token must be at least 32 bytes\n' >&2
    return 1
  fi

  FORMAL_FIXTURE_TARGET_ID='target_local_docker_v1'
  FORMAL_FIXTURE_RUNNER_TARGET_TOKEN="$token"
  FORMAL_FIXTURE_SECRET_ROOT="$work_root/secrets"
  FORMAL_FIXTURE_TARGET_TOKEN_FILE="$FORMAL_FIXTURE_SECRET_ROOT/runner-targets/$FORMAL_FIXTURE_TARGET_ID.token"

  mkdir -p "$FORMAL_FIXTURE_SECRET_ROOT/runner-targets"
  chmod 700 "$FORMAL_FIXTURE_SECRET_ROOT" "$FORMAL_FIXTURE_SECRET_ROOT/runner-targets"
  printf '%s' "$FORMAL_FIXTURE_RUNNER_TARGET_TOKEN" > "$FORMAL_FIXTURE_TARGET_TOKEN_FILE"
  chmod 600 "$FORMAL_FIXTURE_TARGET_TOKEN_FILE"
  [ "$(stat -c '%a' "$FORMAL_FIXTURE_TARGET_TOKEN_FILE")" = '600' ]
}

formal_fixture_wait_runner_ready() {
  local base="$1"
  local target_id="${2:-$FORMAL_FIXTURE_TARGET_ID}"
  local target=''

  for _ in $(seq 1 100); do
    target=$(api "$base/v1/runner-targets/$target_id" || true)
    if printf '%s' "$target" | node -e '
      let body=""
      process.stdin.on("data", chunk => body += chunk).on("end", () => {
        try {
          const value = JSON.parse(body)
          process.exit(value.health === "online" && value.service_identity?.available === true ? 0 : 1)
        } catch { process.exit(1) }
      })
    '; then
      return 0
    fi
    sleep 0.1
  done

  printf 'runner target %s did not become ready: %s\n' "$target_id" "$target" >&2
  return 1
}

formal_fixture_register_data_file() {
  local base="$1"
  local project_id="$2"
  local data_file="$3"
  local content

  content=$(base64 -w0 "$data_file")
  api -X POST "$base/v1/artifacts" \
    -d "{\"project_id\":\"$project_id\",\"kind\":\"data\",\"content_base64\":\"$content\"}" \
    | jfield '.artifact_id'
}

formal_fixture_register_protocol() {
  local base="$1"
  local project_id="$2"
  local contract_id="$3"
  local code_artifact_id="$4"
  local data_artifact_id="$5"
  local principal_id="$6"
  local protocol_id="$7"
  local primary_metric="$8"
  local contract_json target_hash protocol_body

  contract_json=$(api "$base/v1/projects/$project_id/contracts" | CONTRACT_ID="$contract_id" node -e '
    let body=""
    process.stdin.on("data", chunk => body += chunk).on("end", () => {
      const contract = JSON.parse(body).find(value => value.contract_id === process.env.CONTRACT_ID)
      if (contract === undefined) process.exit(2)
      process.stdout.write(JSON.stringify(contract))
    })
  ')
  target_hash=$(api "$base/v1/runner-targets/$FORMAL_FIXTURE_TARGET_ID" | jfield '.config_hash')

  protocol_body=$(cd "$REPO" && \
    CONTRACT_JSON="$contract_json" \
    PROJECT_ID="$project_id" \
    CONTRACT_ID="$contract_id" \
    CODE_ARTIFACT_ID="$code_artifact_id" \
    DATA_ARTIFACT_ID="$data_artifact_id" \
    TARGET_ID="$FORMAL_FIXTURE_TARGET_ID" \
    TARGET_HASH="$target_hash" \
    PRINCIPAL_ID="$principal_id" \
    PROTOCOL_ID="$protocol_id" \
    PRIMARY_METRIC="$primary_metric" \
    node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto'
import { canonicalJson } from './packages/research-kernel/lib/kernel.js'
import { protocolRevisionCanonicalHash } from './packages/research-kernel/lib/methodology-store.js'

const contract = JSON.parse(process.env.CONTRACT_JSON)
const record = {
  protocol_id: process.env.PROTOCOL_ID,
  project_id: process.env.PROJECT_ID,
  revision: 1,
  supersedes: null,
  status: 'frozen',
  intent: 'confirmatory',
  research_question_ref: `question_${process.env.PROTOCOL_ID}`,
  target_claim_ref: null,
  hypothesis: 'The approved treatment changes the primary metric.',
  prediction: 'The primary metric differs from the approved baseline.',
  variables: { manipulated: ['treatment'], controlled: ['immutable fixture data'], measured: [process.env.PRIMARY_METRIC] },
  metrics: {
    primary: process.env.PRIMARY_METRIC,
    secondary: [],
    baseline_ref: `baseline_${process.env.PROTOCOL_ID}`,
    analysis_plan_artifact_id: process.env.DATA_ARTIFACT_ID,
  },
  pins: {
    contract: {
      ref: process.env.CONTRACT_ID,
      sha256: `sha256:${createHash('sha256').update(canonicalJson(contract)).digest('hex')}`,
    },
    code: { ref: process.env.CODE_ARTIFACT_ID, sha256: process.env.CODE_ARTIFACT_ID },
    data: { ref: process.env.DATA_ARTIFACT_ID, sha256: process.env.DATA_ARTIFACT_ID },
    environment: { ref: process.env.TARGET_ID, sha256: process.env.TARGET_HASH },
  },
  stopping_conditions: ['complete all approved seeds'],
  failure_criteria: ['integrity failure'],
  allowed_deviations: [],
  deviation_handling: 'Freeze a new Protocol revision before retrying.',
  author_principal_id: process.env.PRINCIPAL_ID,
  created_at: '2026-08-20T00:00:00.000Z',
  frozen_at: '2026-08-20T00:00:00.000Z',
}
record.canonical_hash = protocolRevisionCanonicalHash(record)
process.stdout.write(JSON.stringify({ record, expected_revision: 0 }))
NODE
  )

  api -X POST "$base/v2/projects/$project_id/protocols" \
    -H "x-principal-id: $principal_id" \
    -d "$protocol_body"
}
