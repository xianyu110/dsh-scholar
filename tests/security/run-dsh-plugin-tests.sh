#!/usr/bin/env bash
# acceptance-tests.md §9 (DSH integration) + §17 (tool schema / canonical
# names): the research plugin's tool catalog, ACL, /research subcommand
# handlers, headless tools and skill provider resolution.
#
#   1. Tool catalog == reconstruction-contracts.md §17 canonical registry
#      (29 canonical names), legacy claim_verify/analysis_build/release_bundle
#      registered as one-version deprecation aliases (never unknown tool).
#   2. No Human Decision / gate-decision tool exists; ACL denies unknown and
#      unauthorized agents on every research write tool.
#   3. Tools work headless (no httpServer): registration + execution through
#      the kernel client/cache only.
#   4. /research help|list|status|gates|jobs|claims|new|... all have real
#      handlers returning kernel data (no generic-help fallthrough).
#   5. Skill provider resolves the four groups from the PACKAGE ROOT skills/
#      (never lib/skills) and Brief -> domain/venue selection is deterministic;
#      npm pack ships the runtime skill assets.
#
# Usage: bash tests/security/run-dsh-plugin-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PLUGIN_LIB="$REPO/lib/plugin"
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
if [ ! -f "$PLUGIN_LIB/tools.js" ]; then
  echo "dsh-plugin: plugin not built — run pnpm run build:plugin first" >&2
  exit 2
fi
if [ ! -f "$KERNEL_BIN" ]; then
  echo "dsh-plugin: research kernel not built — run pnpm --filter @dsh-scholar/research-kernel build first" >&2
  exit 2
fi

PASS=0
FAIL=0
say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }
jnode() { node --input-type=module "$@"; }
# probe <json> <js-expression>: exits 0 when the expression is truthy
probe() { printf '%s' "$1" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!($2))process.exit(1)})" > /dev/null 2>&1; }

WORK=$(mktemp -d)
KERNEL_PID=""
cleanup() {
  [ -n "$KERNEL_PID" ] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── §17: canonical catalog + deprecation aliases + ACL + headless tools ────
say "canonical tool catalog / deprecation aliases / ACL / headless"
CATALOG=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { registerResearchTools } = await import(`${repo}/lib/plugin/tools.js`)
const { RoleRegistry, RESEARCH_TOOLS, ROLE_TOOLS, TOOL_ALIASES, DEFAULT_ROLE } = await import(`${repo}/lib/plugin/acl.js`)

const CANONICAL = [
  'research_project', 'research_phase', 'research_gate_request', 'research_budget',
  'research_status', 'literature_search', 'paper_resolve', 'corpus_snapshot',
  'passage_lookup', 'research_panel', 'idea_create', 'idea_compare', 'novelty_audit',
  'workspace_snapshot', 'patch_apply', 'baseline_prepare', 'test_run', 'baseline_verify',
  'experiment_register', 'experiment_submit', 'experiment_status', 'experiment_cancel',
  'evidence_note_create', 'claim_create', 'claim_verify_request', 'analysis_request',
  'manuscript_build', 'manuscript_review', 'release_bundle_request',
]
if (CANONICAL.length !== 29) throw new Error(`§17 registry has ${CANONICAL.length} entries, expected 29`)

const registered = []
// Tool defs capture `client` at registration time; one registration serves
// all probes. getProjectBySession is session-aware: only the headless probe
// session resolves to a project.
const stubClient = {
  getProjectBySession: async (sid) => sid === 'headless-session' ? { project_id: 'rsp_headless' } : null,
  projectProjection: async () => ({ project: { status: 'DRAFT' }, counts: { claims: 0 } }),
  verifyClaim: async () => ({ claim_id: 'claim_x', status: 'supported' }),
  createProject: async () => ({ project_id: 'rsp_x', brief: { domain: 'machine-learning', target_venue: null } }),
}
const stubCache = { get: async () => undefined, set: async () => undefined }
const roles = new RoleRegistry()
registerResearchTools({ tools: { register: t => registered.push(t) } },
  { client: stubClient, cache: stubCache, ctx: {}, roles, modelFor: () => undefined })

const names = registered.map(t => t.name)
const problems = []

// 1. every §17 canonical name is registered
for (const c of CANONICAL) if (!names.includes(c)) problems.push(`missing canonical tool ${c}`)

// 2. legacy names registered as deprecation aliases with catalog metadata
for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
  const t = registered.find(x => x.name === alias)
  if (t === undefined) { problems.push(`legacy alias ${alias} not registered (unknown tool risk)`); continue }
  const desc = String(t.description ?? '')
  if (!/deprecated/i.test(desc)) problems.push(`alias ${alias} description lacks DEPRECATED marker`)
  if (!desc.includes(canonical)) problems.push(`alias ${alias} description lacks canonical name ${canonical}`)
}

// 3. no Human Decision / gate-decision tool exists
const gateDecision = names.filter(n => /gate.*(decide|decision|approve)|(decide|decision).*gate/.test(n))
if (gateDecision.length > 0) problems.push(`gate-decision tools must not exist: ${gateDecision.join(',')}`)
const gateTool = registered.find(x => x.name === 'research_gate_request')
if (gateTool !== undefined) {
  const actions = gateTool.parameters?.properties?.action?.enum ?? []
  if (actions.some(a => String(a) === 'decide')) problems.push('research_gate_request must not expose action=decide')
}
// 4. ACL surface: RESEARCH_TOOLS covers canonical + aliases; role surfaces canonical-only
for (const n of names) if (!RESEARCH_TOOLS.includes(n)) problems.push(`RESEARCH_TOOLS missing ${n}`)
for (const c of CANONICAL) if (!RESEARCH_TOOLS.includes(c)) problems.push(`RESEARCH_TOOLS missing canonical ${c}`)
for (const role of Object.keys(ROLE_TOOLS)) {
  for (const t of ROLE_TOOLS[role]) {
    if (!CANONICAL.includes(t)) problems.push(`ROLE_TOOLS[${role}] has non-canonical ${t}`)
  }
}
// 5. unknown/unregistered agent -> DEFAULT_ROLE none -> every tool denied
for (const n of names) if (roles.allows(DEFAULT_ROLE, n)) problems.push(`unknown agent may call ${n}`)
if (roles.get('some-unknown-session') !== 'none') problems.push('unknown session role must be none')
if (roles.allows('writer', 'claim_verify_request')) problems.push('writer must not verify claims')
if (roles.allows('writer', 'claim_verify')) problems.push('writer must not call claim_verify alias')
if (!roles.allows('statistician', 'claim_verify_request')) problems.push('statistician must verify claims')
if (!roles.allows('statistician', 'claim_verify')) problems.push('statistician must be allowed the claim_verify alias')
if (roles.allows('reviewer', 'analysis_request')) problems.push('reviewer must not run analysis_request')

// 6. headless: no httpServer anywhere — execute a tool through the kernel
// client/cache and check the alias returns deprecation metadata
const statusTool = registered.find(x => x.name === 'research_status')
const headless = await statusTool.execute({}, { agent: { id: 'headless-session' }, signal: new AbortController().signal })
if (headless.ok !== true) problems.push('headless research_status execution failed')

const aliasTool = registered.find(x => x.name === 'claim_verify')
const aliasResult = await aliasTool.execute(
  { claim_id: 'claim_x', evidence_ids_json: '["ev_1"]' },
  { agent: { id: 's' }, signal: new AbortController().signal })
if (aliasResult.deprecated !== true) problems.push('claim_verify alias response lacks deprecated metadata')
if (aliasResult.canonical !== 'claim_verify_request') problems.push('claim_verify alias response lacks canonical name')

console.log(JSON.stringify({ names, aliasCount: Object.keys(TOOL_ALIASES).length, problems }))
EOF
)

NAMES=$(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).names.join(',')))")
PROBLEMS=$(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")
ALIASN=$(printf '%s' "$CATALOG" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).aliasCount))")

if [ -z "$PROBLEMS" ]; then
  ok "all 29 §17 canonical tools registered, aliases + ACL consistent"
else
  bad "catalog/ACL problems: $PROBLEMS"
fi
for C in claim_verify_request analysis_request release_bundle_request research_project research_gate_request research_budget; do
  case ",$NAMES," in
    *",$C,"*) ok "canonical tool $C registered" ;;
    *) bad "canonical tool $C missing" ;;
  esac
done
for A in claim_verify analysis_build release_bundle; do
  case ",$NAMES," in
    *",$A,"*) ok "deprecation alias $A still registered (not unknown tool)" ;;
    *) bad "deprecation alias $A missing" ;;
  esac
done
[ "$ALIASN" = "3" ] && ok "exactly 3 one-version deprecation aliases" || bad "alias count $ALIASN"
case ",$NAMES," in
  *",research_gate,"*|*",research_gate_decide,"*|*",gate_decide,"*) bad "gate-decision tool present in catalog" ;;
  *) ok "no gate-decision tool in catalog" ;;
esac
if probe "$CATALOG" "!j.problems.some(p=>/unknown agent/.test(p))"; then
  ok "unknown/unregistered agent denied on every research tool"
else
  bad "unknown agent ACL leak"
fi
if probe "$CATALOG" "!j.problems.some(p=>/headless/.test(p))"; then
  ok "research tools execute headless (no httpServer)"
else
  bad "headless execution failed"
fi
if probe "$CATALOG" "!j.problems.some(p=>/deprecated metadata/.test(p))"; then
  ok "legacy alias responses carry deprecation metadata + canonical name"
else
  bad "alias deprecation metadata missing"
fi

# ── §9 DSH-01: unknown Agent ACL deny + pre-execute semantics + disposer ─────
# Isolated fixture: unknown/unregistered agent ids resolve to role 'none'
# (DEFAULT_ROLE) and every research write tool is denied; known roles keep
# their documented surface (director = PI); agent-less calls pass through
# (tool-layer semantics); the plugin's ctx.effect disposer stops the sidecar.
say "DSH-01: unknown-agent deny / pre-execute waterfall / plugin disposer"
DSH01=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { RoleRegistry, RESEARCH_TOOLS, DEFAULT_ROLE, ROLE_TOOLS } = await import(`${repo}/lib/plugin/acl.js`)
const { apply, KernelSidecar } = await import(`${repo}/lib/plugin/index.js`)

const problems = []

// 1. DEFAULT_ROLE = none; unknown sessions resolve to none; none has an
//    EMPTY tool surface -> every research tool is denied for unknown agents.
if (DEFAULT_ROLE !== 'none') problems.push('DEFAULT_ROLE must be none')
const roles = new RoleRegistry()
if (roles.get('some-unknown-agent-42') !== 'none') problems.push('unknown session role must resolve to none')
if (ROLE_TOOLS.none.length !== 0) problems.push('none role surface must be empty')
for (const tool of RESEARCH_TOOLS) {
  if (roles.allows(DEFAULT_ROLE, tool)) problems.push(`unknown agent may call ${tool}`)
}

// 2. pre-execute waterfall replicated 1:1 from src/plugin/index.ts (the
//    tools/pre-execute listener): agent-id calls on research tools go
//    through RoleRegistry.allows and are denied outside the role surface;
//    agent-less calls and non-research tools pass through to next().
const researchToolSet = new Set(RESEARCH_TOOLS)
const preExecute = async (exec, next) => {
  const agentId = exec.agent?.id
  if (agentId !== undefined && researchToolSet.has(exec.name)) {
    const role = roles.get(agentId)
    if (!roles.allows(role, exec.name)) {
      return { kind: 'deny', reason: `research tool ${exec.name} is outside the ${role} role's tool surface` }
    }
  }
  return next()
}
const run = async (agentId, tool) => {
  let calledNext = false
  const result = await preExecute(
    { agent: agentId === undefined ? undefined : { id: agentId }, name: tool },
    () => { calledNext = true; return 'NEXT' },
  )
  return result?.kind === 'deny' ? 'deny' : calledNext ? 'allow' : 'other'
}

// unknown agent: EVERY research tool (canonical + deprecation alias) denied
for (const tool of RESEARCH_TOOLS) {
  if (await run('unknown-agent-abc', tool) !== 'deny') problems.push(`unknown agent NOT denied on ${tool}`)
}
// known role (director = the PI surface, docs/dsh-integration.md §4):
// every tool in its surface is allowed; the alias is canonical-only.
roles.set('pi-session', 'director')
for (const tool of ROLE_TOOLS.director) {
  if (await run('pi-session', tool) !== 'allow') problems.push(`director denied on ${tool}`)
}
if (await run('pi-session', 'claim_verify') !== 'deny') problems.push('director must not get the claim_verify alias (canonical-only surface)')
// statistician: claim_verify_request allowed (canonical + alias),
// project creation denied.
roles.set('stat-session', 'statistician')
if (await run('stat-session', 'claim_verify_request') !== 'allow') problems.push('statistician denied claim_verify_request')
if (await run('stat-session', 'claim_verify') !== 'allow') problems.push('statistician denied claim_verify alias')
if (await run('stat-session', 'research_project') !== 'deny') problems.push('statistician must not create projects')
// writer: manuscript_build allowed; research writes and the verify alias denied.
roles.set('writer-session', 'writer')
if (await run('writer-session', 'manuscript_build') !== 'allow') problems.push('writer denied manuscript_build')
if (await run('writer-session', 'research_project') !== 'deny') problems.push('writer must not create projects')
if (await run('writer-session', 'claim_verify') !== 'deny') problems.push('writer must not verify claims (alias)')
// no agent id: tool-layer semantics — ACL never restricts agent-less calls.
if (await run(undefined, 'research_project') !== 'allow') problems.push('agent-less call must pass through the ACL')
if (await run(undefined, 'claim_verify_request') !== 'allow') problems.push('agent-less claim_verify_request must pass through')
// non-research tools are outside the ACL surface.
if (await run('unknown-agent-abc', 'web_fetch') !== 'allow') problems.push('non-research tool must pass through')

// 3. register disposer: apply() registers ctx.effect -> sidecar.stop();
//    a simulated dispose must invoke it (acceptance §9 "插件停止清理
//    tool/listener/sidecar ownership").
let startCalled = 0
let stopCalled = 0
const origStart = KernelSidecar.prototype.start
const origStop = KernelSidecar.prototype.stop
KernelSidecar.prototype.start = async function () { startCalled += 1 }
KernelSidecar.prototype.stop = async function () { stopCalled += 1 }
const cleanups = []
const ctx = {
  logger: () => ({ info() {}, error() {}, warn() {} }),
  provide() {},
  plugin: async () => ({}),
  on() {},
  effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d) },
  tools: { register() {} },
  commands: { register() {} },
}
try {
  apply(ctx, { kernel: { host: '127.0.0.1', port: 7412, dataDir: process.env.DSH01_DATA ?? '/tmp/dsh01' }, cacheDir: process.env.DSH01_CACHE ?? '/tmp/dsh01-cache' })
  if (startCalled < 1) problems.push('apply must start the kernel sidecar')
  for (const cleanup of cleanups) await cleanup()
  if (stopCalled < 1) problems.push('plugin dispose must stop the kernel sidecar (disposer missing)')
} finally {
  KernelSidecar.prototype.start = origStart
  KernelSidecar.prototype.stop = origStop
}

console.log(JSON.stringify({ problems }))
EOF
)
if [ -z "$DSH01" ]; then
  bad "DSH-01 probe script produced no output"
else
  if probe "$DSH01" "j.problems.length === 0"; then
    ok "unknown agent denied on every research tool; known roles keep their surface"
  else
    bad "DSH-01 ACL: $(printf '%s' "$DSH01" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/unknown agent NOT denied/.test(p))"; then
    ok "unknown agent denied on every research write tool (DSH-01)"
  else
    bad "unknown-agent ACL leak"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/agent-less/.test(p))"; then
    ok "agent-less tool calls pass through the ACL (tool-layer semantics)"
  else
    bad "agent-less call restricted by ACL"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/alias/.test(p))"; then
    ok "deprecation aliases stay ACL-enforced on canonical surfaces"
  else
    bad "alias ACL leak"
  fi
  if probe "$DSH01" "!j.problems.some(p=>/dispose/.test(p))"; then
    ok "plugin disposer stops the kernel sidecar (register cleanup)"
  else
    bad "plugin disposer missing sidecar stop"
  fi
fi

# ── §9: /research subcommand handlers against a real kernel ────────────────
say "research subcommands (kernel-backed)"
PORT=$((21500 + $$ % 400))
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
READY=0
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1; then READY=1; break; fi
  sleep 0.1
done
if [ "$READY" = 1 ]; then
  ok "research kernel healthy"
else
  bad "kernel did not start"
  exit 1
fi

CMDS=$(jnode - "$REPO" "$PORT" <<'EOF'
const repo = process.argv[2]
const port = process.argv[3]
const { registerResearchCommands } = await import(`${repo}/lib/plugin/commands.js`)
const { ResearchClient } = await import('@dsh-scholar/research-client')

const client = new ResearchClient({ endpoint: `http://127.0.0.1:${port}` })
const captured = {}
registerResearchCommands({ commands: { register: def => { captured.def = def } } },
  { client, cache: {}, unattended: false })
const handler = captured.def.handler
// DSH commands hand the handler the text AFTER the slash command name
// (parseCommand: rawInput = line.slice(match[0].length)).
const run = async (rawInput) => handler({ agent: { id: 'plugin-test-agent' }, rawInput: rawInput.replace(/^\/research\s*/, '') })

const results = {}
results.help = await run('/research help')
results.listEmpty = await run('/research list')
results.claimsNoProject = await run('/research claims')
results.new = await run('/research new mlproj {"domain":"machine-learning","target_venue":"iclr-2026"}')
const projId = /rsp_[a-z0-9_]+/.exec(results.new.text)?.[0] ?? ''
results.status = await run(`/research status ${projId}`)
results.gates = await run(`/research gates ${projId}`)
results.jobs = await run(`/research jobs ${projId}`)
results.claims = await run(`/research claims ${projId}`)
results.list = await run('/research list')
results.unknown = await run('/research frobnicate')
console.log(JSON.stringify({ results, projId }))
EOF
)
if [ -z "$CMDS" ]; then
  bad "subcommand probe script produced no output"
else
  for SUB in help listEmpty new status gates jobs claims list; do
    if probe "$CMDS" "j.results['$SUB'] && j.results['$SUB'].kind === 'success'"; then
      ok "/research $SUB has a real handler"
    else
      bad "/research $SUB handler failed"
    fi
  done
  if probe "$CMDS" "j.results.claimsNoProject && j.results.claimsNoProject.kind === 'error' && /session-linked/.test(j.results.claimsNoProject.text)"; then
    ok "/research claims without project -> explicit error (real handler, not help)"
  else
    bad "/research claims missing-project path"
  fi
  if probe "$CMDS" "/domain-machine-learning/.test(j.results.new.text) && /venue-templates/.test(j.results.new.text)"; then
    ok "new echoes deterministic domain/venue skill selection"
  else
    bad "new lacks deterministic skill selection"
  fi
  if probe "$CMDS" "/scope/.test(j.results.gates.text)"; then
    ok "gates returns real kernel gate data (scope gate)"
  else
    bad "gates handler returned no gate data"
  fi
  if probe "$CMDS" "/0 claim/.test(j.results.claims.text)"; then
    ok "claims returns real kernel ledger data (counts)"
  else
    bad "claims handler returned no ledger data"
  fi
  if probe "$CMDS" "/subcommands/.test(j.results.unknown.text) && j.results.unknown.kind === 'success'"; then
    ok "unknown subcommand falls back to documented help text"
  else
    bad "unknown subcommand did not return help"
  fi
  if probe "$CMDS" "j.projId !== '' && /rsp_/.test(j.results.status.text)"; then
    ok "status returns the real project projection"
  else
    bad "status handler returned no projection"
  fi
fi

# ── §9: skills — package-root resolution + deterministic selection + pack ──
say "skills: package-root provider, deterministic selection, npm pack"
SKILLS=$(jnode - "$REPO" <<'EOF'
const repo = process.argv[2]
const { resolveSkillRoot, resolveSkillDirs, selectSkillPacks, selectedSkillNames, SKILL_GROUPS } = await import(`${repo}/lib/plugin/skills.js`)
const { existsSync } = await import('node:fs')
const { dirname, sep } = await import('node:path')
const root = resolveSkillRoot()
const problems = []
if (!root.endsWith(sep + 'skills')) problems.push(`skill root not package-root skills/: ${root}`)
if (!existsSync(root)) problems.push(`skill root missing: ${root}`)
for (const name of SKILL_GROUPS) {
  if (!existsSync(`${root}/${name}/SKILL.md`)) problems.push(`skill group missing: ${name}`)
}
if (existsSync(`${dirname(root)}/lib/skills`)) problems.push('lib/skills must not exist')
const dirs = resolveSkillDirs()
if (dirs.length !== 4) problems.push(`expected 4 skill dirs, got ${dirs.length}`)
const cases = [
  [{ domain: 'machine-learning', target_venue: 'iclr-2026' }, ['research-core', 'domain-machine-learning', 'venue-templates']],
  [{ domain: 'ML', target_venue: null }, ['research-core', 'domain-machine-learning']],
  [{ domain: 'data-science', target_venue: null }, ['research-core', 'domain-data-science']],
  [{ domain: 'tabular data science', target_venue: 'conference' }, ['research-core', 'domain-data-science', 'venue-templates']],
  [{ domain: 'physics', target_venue: 'some-journal-of-x' }, ['research-core', 'venue-templates']],
  [{ domain: 'physics', target_venue: null }, ['research-core']],
  [null, ['research-core']],
]
for (const [brief, expected] of cases) {
  const got = selectedSkillNames(brief)
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    problems.push(`selection ${JSON.stringify(brief)} -> ${got.join(',')} expected ${expected.join(',')}`)
  }
  if (JSON.stringify(got) !== JSON.stringify(selectedSkillNames(brief))) {
    problems.push(`selection not deterministic for ${JSON.stringify(brief)}`)
  }
}
console.log(JSON.stringify({ problems, dirs: dirs.map(d => d.name) }))
EOF
)
if probe "$SKILLS" "j.problems.length === 0"; then
  ok "skill provider resolves the four groups from the package root (no lib/skills)"
else
  bad "skill resolution: $(printf '%s' "$SKILLS" | jnode -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).problems.join('|')))")"
fi
if probe "$SKILLS" "j.dirs.length === 4"; then
  ok "all four skill groups discoverable (research-core + 2 domains + venue)"
else
  bad "skill groups incomplete"
fi

PACKLIST=$(cd "$REPO" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | grep -E 'skills/(research-core|domain-machine-learning|domain-data-science|venue-templates)/SKILL.md' || true)
for S in research-core domain-machine-learning domain-data-science venue-templates; do
  if printf '%s' "$PACKLIST" | grep -q "skills/$S/SKILL.md"; then
    ok "npm pack ships skills/$S/SKILL.md"
  else
    bad "npm pack missing skills/$S/SKILL.md"
  fi
done

echo "== dsh-plugin tests: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
