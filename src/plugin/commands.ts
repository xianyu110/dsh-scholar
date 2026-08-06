/**
 * `/research` command surface (design 附录 A). Commands are thin orchestrators
 * over the Kernel API; heavy lifting stays in tools and the Kernel. In
 * unattended mode commands never block on questions — they create gates and
 * report BLOCKED_GATE status.
 * @module @dsh-scholar/research-plugin/commands
 */

import type { Context } from 'cordis'
// Module augmentation: ctx.commands (CommandService).
import type {} from '@deepseek-ai/dsh-commands'
import type { ResearchClient } from '@dsh-scholar/research-client'
import type { ConnectorCache } from '@dsh-scholar/scholar-connectors'
import { multiSourceSearch } from '@dsh-scholar/scholar-connectors'

export interface CommandContext {
  client: ResearchClient
  cache: ConnectorCache
  unattended: boolean
}

function parseSub(rawInput: string): { sub: string; rest: string } {
  const trimmed = rawInput.trim()
  const space = trimmed.indexOf(' ')
  if (space === -1) return { sub: trimmed, rest: '' }
  return { sub: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() }
}

function jsonArg(rest: string): { json: string; positional: string } {
  const match = /^(\{.*\})\s*(.*)$/s.exec(rest)
  if (match === null) return { json: '', positional: rest }
  return { json: match[1] ?? '', positional: match[2] ?? '' }
}

function briefFromJson(json: string): Record<string, unknown> | null {
  if (json === '') return null
  try {
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function fmt(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Register the `/research` command family. */
export function registerResearchCommands(ctx: Context, commandCtx: CommandContext): void {
  const { client, cache, unattended } = commandCtx

  ctx.commands.register({
    name: 'research',
    description: 'DSH Research OS: create and drive a Research Project (new|status|survey|ideas|contract|run|evidence|write|export|release)',
    input: { hint: '<new|status|survey|ideas|contract|run|evidence|write|export|release> ...' },
    handler: async invocation => {
      const sessionId = invocation.agent.id
      const { sub, rest } = parseSub(invocation.rawInput)

      try {
        switch (sub) {
          case 'new': {
            const { json, positional } = jsonArg(rest)
            const name = positional.split(/\s+/)[0] ?? ''
            if (name === '') {
              return { kind: 'error' as const, text: '/research new <name> [<brief-json>] — name is required' }
            }
            const brief = briefFromJson(json)
            const project = await client.createProject({
              name,
              workspace: `/research/${name}`,
              brief: {
                problem: String(brief?.problem ?? 'To be specified in the Scope Gate.'),
                scope: String(brief?.scope ?? 'To be specified in the Scope Gate.'),
                questions: Array.isArray(brief?.questions) ? brief.questions.map(String) : [],
                primary_metrics: Array.isArray(brief?.primary_metrics) ? brief.primary_metrics.map(String) : [],
                resources: String(brief?.resources ?? ''),
                risks: Array.isArray(brief?.risks) ? brief.risks.map(String) : [],
                target_outputs: Array.isArray(brief?.target_outputs) ? brief.target_outputs.map(String) : ['conference-paper'],
                target_venue: brief?.target_venue !== undefined ? String(brief.target_venue) : null,
                baseline_repo: brief?.baseline_repo !== undefined ? String(brief.baseline_repo) : null,
                domain: String(brief?.domain ?? 'machine-learning'),
              },
              session_id: sessionId,
            })
            const gate = await client.createGate({
              project_id: project.project_id,
              type: 'scope',
              title: `Scope Gate — ${project.name}`,
              summary: 'Approve the research scope, data policy, budget and target venue.',
              session_id: sessionId,
            })
            const text = `Research project created: **${project.project_id}** (${project.name})\n\n`
              + `Status: ${project.status}. Pending **Scope Gate** ${gate.gate_id}.\n\n`
              + `Approve it (human) via the research_gate tool: action=decide gate_id=${gate.gate_id} decision=approved.`
            if (unattended) {
              return { kind: 'success' as const, text: `${text}\n\n[unattended] project parked at Scope Gate (BLOCKED_GATE on timeout); no blocking question asked.` }
            }
            return { kind: 'success' as const, text }
          }

          case 'status': {
            const projectId = rest.trim() || undefined
            const linked = projectId !== undefined
              ? await client.getProject(projectId)
              : await client.getProjectBySession(sessionId)
            if (linked === null) {
              return { kind: 'error' as const, text: 'No session-linked research project. Create one with /research new <name> or pass a project_id.' }
            }
            const projection = await client.projectProjection(linked.project_id)
            const pending = projection.pending_gates.map(g => `  - ${g.type} gate ${g.gate_id}: ${g.title} (${g.status})`).join('\n') || '  none'
            const jobs = projection.jobs.map(j => `  - ${j.job_id} [${j.kind}] ${j.status}`).join('\n') || '  none'
            const text = `**${linked.name}** (${linked.project_id}) — phase \`${projection.project.status}\` rev ${projection.project.revision}\n\n`
              + `Next actions:\n${projection.next_actions.map(a => `  - ${a}`).join('\n')}\n\n`
              + `Pending gates:\n${pending}\n\n`
              + `Jobs:\n${jobs}\n\n`
              + `Budget: $${projection.budget.model_cost_usd ?? 0} / ${projection.project.constraints.max_model_cost_usd} max, `
              + `${projection.budget.gpu_hours ?? 0} / ${projection.project.constraints.max_gpu_hours} GPU-h\n\n`
              + `Counts: ${fmt(projection.counts)}`
            return { kind: 'success' as const, text }
          }

          case 'survey': {
            const project = await requireProject(client, sessionId, undefined)
            const query = rest.trim()
            if (query === '') return { kind: 'error' as const, text: '/research survey <query> — query required' }
            const result = await multiSourceSearch(query, { limit: 20 }, cache)
            const snapshot = await client.snapshotCorpus({
              project_id: project.project_id,
              queries: result.queries,
              papers: result.hits.map(h => h.paper),
            })
            const samples = result.hits.slice(0, 5).map(h => `  - ${h.paper.paper_id}: ${h.paper.title} (${h.paper.year ?? 'n.d.'})`).join('\n')
            const text = `Survey complete: **${snapshot.snapshot_id}** — ${snapshot.papers.length} papers after dedup (${result.dedup_removed} removed).\n\n`
              + `Top hits:\n${samples}\n\n`
              + `Next: /research ideas (or generate IdeaCards with idea_create + novelty_audit).`
            return { kind: 'success' as const, text }
          }

          case 'ideas': {
            const project = await requireProject(client, sessionId, undefined)
            const ideas = await client.listIdeas(project.project_id) as unknown as Array<Record<string, unknown>>
            const text = ideas.length === 0
              ? `No IdeaCards yet for ${project.project_id}. Have the Idea Panel create 3-5 cards with idea_create, then run novelty_audit before the Idea Gate.`
              : `IdeaCards for ${project.project_id}:\n${ideas.map(i => `  - ${String(i.idea_id)} [${String(i.status)}] ${String(i.title)}`).join('\n')}`
            return { kind: 'success' as const, text }
          }

          case 'contract': {
            const project = await requireProject(client, sessionId, undefined)
            const { json } = jsonArg(rest)
            const data = briefFromJson(json)
            if (data === null) {
              return { kind: 'error' as const, text: '/research contract <json> — supply contract JSON (idea_id, dataset_id, baseline, treatment, primary_metric, seeds)' }
            }
            const seeds = Array.isArray(data.seeds) ? data.seeds.map(Number) : [11, 23, 47, 89, 101]
            const contract = await client.registerContract({
              project_id: project.project_id,
              idea_id: String(data.idea_id ?? ''),
              data: { dataset_id: String(data.dataset_id ?? ''), version: String(data.version ?? 'official'), split: String(data.split ?? 'official') },
              methods: { baseline: String(data.baseline ?? ''), treatment: String(data.treatment ?? '') },
              metrics: { primary: String(data.primary_metric ?? ''), secondary: Array.isArray(data.secondary) ? data.secondary.map(String) : [] },
              seeds,
              analysis: { effect_size: 'mean_difference', interval: 'bootstrap_95', multiple_testing: 'holm' },
              ablations: Array.isArray(data.ablations) ? data.ablations.map(String) : [],
              stop_conditions: { max_gpu_hours: Number(data.max_gpu_hours ?? 48), min_completed_seeds: Number(data.min_completed_seeds ?? seeds.length), stop_on_data_leakage: true },
            })
            const text = `ExperimentContract **${contract.contract_id}** v${contract.version} registered (status ${contract.status}).\n\n`
              + `Next: reproduce baseline → Contract Gate approval (human).`
            return { kind: 'success' as const, text }
          }

          case 'run': {
            const project = await requireProject(client, sessionId, undefined)
            const { json, positional } = jsonArg(rest)
            const data = briefFromJson(json)
            const kind = positional.trim() || String(data?.kind ?? 'echo')
            const idem = String(data?.idempotency_key ?? `cmd-run-${Date.now()}`)
            const job = await client.submitJob({
              project_id: project.project_id,
              idempotency_key: idem,
              kind,
              command: Array.isArray(data?.command) ? data.command.map(String) : [],
              payload: { message: String(data?.message ?? `/research run ${kind}`), ...(data ?? {}) },
              contract_id: data?.contract_id !== undefined ? String(data.contract_id) : null,
            })
            const text = `Job **${job.job_id}** [${job.kind}] submitted (${job.status}, idempotency ${idem}).\n\n`
              + `The runner gateway (node workers/runner-gateway) executes it in isolation and finalizes the RunManifest.`
            return { kind: 'success' as const, text }
          }

          case 'evidence': {
            const project = await requireProject(client, sessionId, undefined)
            const { json } = jsonArg(rest)
            const data = briefFromJson(json)
            if (data === null) {
              return { kind: 'error' as const, text: '/research evidence <json> — supply evidence JSON (analysis_method, result{primary_metric,value,...})' }
            }
            const item = await client.ingestEvidence({
              project_id: project.project_id,
              source_type: String(data.source_type ?? 'run') as never,
              run_ids: Array.isArray(data.run_ids) ? data.run_ids.map(String) : [],
              artifact_refs: Array.isArray(data.artifact_refs) ? data.artifact_refs.map(String) : [],
              analysis_method: String(data.analysis_method ?? ''),
              result: (data.result ?? {}) as Record<string, unknown>,
              uncertainty: String(data.uncertainty ?? ''),
            })
            return { kind: 'success' as const, text: `EvidenceItem **${item.evidence_id}** ingested.\n\nNext: bind claims with claim_verify.` }
          }

          case 'write': {
            const project = await requireProject(client, sessionId, undefined)
            const draft = await client.buildManuscript(project.project_id, 'markdown', true)
            const review = await client.manuscriptReview(project.project_id)
            const text = `Manuscript **${draft.manuscript_id}** built from the Evidence Ledger (artifact ${draft.artifact_id}, ${draft.claims_used} supported claims).\n\n`
              + `Reviewer checks: ${review.pass ? 'PASS' : 'SEE CHECKS'}\n`
              + review.checks.map(c => `  - [${c.status}] ${c.check}: ${c.detail}`).join('\n') + '\n\n'
              + draft.text.slice(0, 4000)
            return { kind: 'success' as const, text }
          }

          case 'export': {
            const project = await requireProject(client, sessionId, undefined)
            const bundle = await client.releaseBundle(project.project_id)
            const text = `Release bundle **${bundle.bundle_id}** generated (artifact ${bundle.artifact_id}).\n`
              + `Contents: ${bundle.contents.join(', ')}.\n\n`
              + `Release Gate is **${bundle.release_gate}** — publication requires an explicit human decision; there is no automatic path.`
            return { kind: 'success' as const, text }
          }

          case 'release': {
            const project = await requireProject(client, sessionId, undefined)
            const gate = await client.createGate({
              project_id: project.project_id,
              type: 'release',
              title: 'Release Gate — explicit human decision required',
              summary: 'Explicit human decision required: authors, licenses, public scope and target platform.',
              session_id: sessionId,
            })
            return { kind: 'success' as const, text: `Release Gate **${gate.gate_id}** created and left **pending** (human only). Nothing is published automatically.` }
          }

          default:
            return {
              kind: 'success' as const,
              text: 'DSH Research OS — /research subcommands:\n'
                + '  new <name> [json]     create project + Scope Gate\n'
                + '  status [project_id]   phase, gates, jobs, budget, next actions\n'
                + '  survey <query>        multi-source search + frozen CorpusSnapshot\n'
                + '  ideas                 list IdeaCards (generate via idea_create tool)\n'
                + '  contract <json>       pre-register an ExperimentContract\n'
                + '  run [kind] [json]     submit a durable runner job\n'
                + '  evidence <json>       ingest a statistical EvidenceItem\n'
                + '  write                 build manuscript from the read-only ledger\n'
                + '  export                private Release Bundle (not publication)\n'
                + '  release               create the human Release Gate',
            }
        }
      } catch (error) {
        return { kind: 'error' as const, text: `research: ${(error as Error).message}` }
      }
    },
  })
}

async function requireProject(client: ResearchClient, sessionId: string, projectId: string | undefined): Promise<{ project_id: string }> {
  if (projectId !== undefined && projectId !== '') return { project_id: projectId }
  const linked = await client.getProjectBySession(sessionId)
  if (linked === null) throw new Error('No session-linked research project. Create one with /research new <name>.')
  return { project_id: linked.project_id }
}
