export interface Projection {
  project?: {
    project_id?: string; name?: string; status?: string; revision?: number
    brief?: { problem?: string; primary_metrics?: string[] }
    constraints?: { max_model_cost_usd?: number; max_gpu_hours?: number; max_parallel_jobs?: number; datasets?: string; external_model_upload?: string }
    execution?: { runner_profile?: string; network_policy?: string; artifact_store?: string }
    integrity?: { require_baseline_reproduction?: boolean; require_experiment_contract?: boolean; require_claim_evidence_links?: boolean; require_clean_room_rerun?: boolean; allow_automatic_public_release?: boolean }
    history?: string[]
  }
  pending_gates?: Array<{ gate_id?: string; type?: string; title?: string; summary?: string; status?: string }>
  jobs?: Array<{ job_id?: string; kind?: string; status?: string; error?: string; contract_id?: string | null }>
  budget?: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }
  counts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number }
  next_actions?: string[]
}

export interface ClaimRow { claim_id?: string; statement?: string; status?: string; confidence?: string; scope?: { dataset?: string; split?: string }; evidence?: { evidence_ids?: string[]; analysis_artifact?: string }; limitations?: string[]; history?: Array<{ status?: string; at?: string; reason?: string }> }
export interface EvidenceRow { evidence_id?: string; analysis_method?: string; result?: { primary_metric?: string; value?: number; effect_size?: number; ci_low?: number; ci_high?: number; n_seeds?: number }; artifact_refs?: string[]; run_ids?: string[] }
export interface ArtifactRow { artifact_id?: string; kind?: string; size_bytes?: number; metadata?: Record<string, unknown> }
export interface GateRow { gate_id?: string; type?: string; title?: string; status?: string; summary?: string }
export interface ProjectRow { project_id?: string; name?: string; status?: string; updated_at?: string }

/** Shared client data shapes (kernel projections + row shapes). */

export interface ContextMenuItem {
  label: string
  hint?: string
  danger?: boolean
  /** dsh-web menu grouping: a divider is drawn before this item. */
  divider?: boolean
  onPick: () => void
}

export interface TerminalLine { seq: number; channel: 'stdout' | 'stderr'; text: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
  time: string
  /** dsh-web quote-reply: the quoted message, shown above the bubble. */
  quote?: { index: number; text: string }
  /** dsh-web pin: starred messages surface in a 📌 section at the top. */
  pinned?: boolean
}

export interface ChatSession { id: string; name: string; messages: ChatMessage[]; lastActive?: number; archived?: boolean; unread?: number; pinned?: boolean }

export interface NotifEntry { text: string; time: string; ts?: number; count?: number }

export interface ManuscriptFile { path: string; version: number; content_hash: string; content?: string }

export interface ManuscriptBuild { build_id: string; revision: number; root_file: string; job_id: string | null; status: string; diagnostics: string; pdf_artifact: string | null; log_artifact: string | null }
