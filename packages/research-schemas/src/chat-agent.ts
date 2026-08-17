/**
 * Private loopback contract between the standalone Scholar BFF and the DSH
 * plugin's model runtime. The browser never sees the bridge endpoint/token.
 * Model output is deliberately limited to conversation text or IdeaDrafts;
 * canonical mutations remain owned by the BFF + Research Kernel.
 */

import { z } from 'zod'
import { IdeaDraft } from './idea.js'

const ChatHistoryItem = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(2_000),
}).strict()

const ChatProjectContext = z.object({
  project_id: z.string().min(1).max(256),
  name: z.string().max(512).optional(),
  status: z.string().max(128).optional(),
  brief_status: z.string().max(128).optional(),
  brief: z.record(z.unknown()).optional(),
  next_actions_v2: z.array(z.record(z.unknown())).max(20).default([]),
}).strict()

const CorpusPaperContext = z.object({
  paper_id: z.string().min(1).max(512),
  title: z.string().min(1).max(1_000),
  year: z.number().int().optional(),
  abstract: z.string().max(2_000).default(''),
}).strict()

export const ScholarAgentRequest = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('conversation'),
    text: z.string().min(1).max(16_000),
    locale: z.enum(['zh', 'en']).default('zh'),
    project: ChatProjectContext,
    history: z.array(ChatHistoryItem).max(12).default([]),
  }).strict(),
  z.object({
    operation: z.literal('generate_ideas'),
    text: z.string().min(1).max(16_000),
    locale: z.enum(['zh', 'en']).default('zh'),
    count: z.number().int().min(1).max(5),
    project: ChatProjectContext,
    corpus: z.object({
      snapshot_id: z.string().min(1).max(256),
      papers: z.array(CorpusPaperContext).min(1).max(30),
    }).strict(),
    history: z.array(ChatHistoryItem).max(12).default([]),
  }).strict(),
])
export type ScholarAgentRequest = z.infer<typeof ScholarAgentRequest>

export const ScholarAgentReply = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('conversation'),
    assistant_text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    operation: z.literal('generate_ideas'),
    ideas: z.array(IdeaDraft).min(1).max(5),
  }).strict(),
])
export type ScholarAgentReply = z.infer<typeof ScholarAgentReply>
