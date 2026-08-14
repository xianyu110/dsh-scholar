/**
 * Model Provider 注册表与项目绑定 schemas（init-grill-upload-models.md §4，
 * 规范性契约；api-contracts.md §19 目标面）。
 *
 * Model Provider 是 instance/global 资源；Project 和 Intake 只能引用
 * opaque `provider_id` 与 `model_id`，不能携带 endpoint、API key、环境变量
 * 名或任意连接参数。
 *
 * SecretRef 是严格 schema：只接受 `scheme | name | version? | scope?`；
 * 出现 `value`、token、password 或任何额外 credential 字段必须拒绝
 * （schema 层 `.strict()` + 显式检查，稳定错误码 `secret_value_forbidden`）。
 * Provider 修改使用 revision CAS（kernel 层 409 provider_revision_conflict）；
 * 运行中的 OCR/Job/PTY/Build 固定创建时 provider/model/config revision/hash。
 *
 * 浏览器响应只显示 SecretRef metadata 与 available 布尔值，绝不返回
 * secret value —— 本 schema 中 credential 只有引用元数据，value 无从存在。
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** SecretRef scheme（keyring/file/vault）。 */
export const SecretRefScheme = z.enum(['keyring', 'file', 'vault'])
export type SecretRefScheme = z.infer<typeof SecretRefScheme>

/**
 * SecretRef —— 严格引用 schema（init-grill-upload-models.md §4）。
 * 出现 `value`/token/password/credential 字段即拒绝（.strict() 拒绝未知
 * 键；下面的 superRefine 再显式点名这些字段以给出稳定错误码）。
 */
export const SecretRef = z.object({
  scheme: SecretRefScheme,
  name: z.string().min(1).max(512),
  version: z.string().max(128).optional(),
  scope: z.string().max(256).optional(),
}).strict().superRefine((value, ctx) => {
  const obj = value as Record<string, unknown>
  for (const forbidden of ['value', 'token', 'password', 'api_key', 'apikey', 'secret', 'credential', 'credentials']) {
    if (forbidden in obj) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [forbidden],
        message: `SecretRef must not carry a '${forbidden}' field — secrets are resolved server-side, never submitted`,
      })
    }
  }
})
export type SecretRef = z.infer<typeof SecretRef>

/** Provider capability（chat/vision/ocr/embedding）。 */
export const ProviderCapability = z.enum(['chat', 'vision', 'ocr', 'embedding'])
export type ProviderCapability = z.infer<typeof ProviderCapability>

/** Provider kind（展示/分类用途；执行层由 capabilities 决定）。 */
export const ProviderKind = z.enum(['openai-compatible', 'anthropic', 'google', 'local', 'mineru', 'custom'])
export type ProviderKind = z.infer<typeof ProviderKind>

/**
 * 模型目录条目。`revision` 在模型行变更时递增（provider 整体 revision 也
 * 递增）；绑定快照固定 provider_revision + config_hash。
 */
export const ProviderModel = z.object({
  model_id: z.string().min(1).max(256),
  display_name: z.string().max(256).optional(),
  capabilities: z.array(ProviderCapability).min(1).default(['chat']),
  revision: z.number().int().positive().default(1),
}).strict()
export type ProviderModel = z.infer<typeof ProviderModel>

/** Provider descriptor（服务器权威形态；响应经 providerRedacted 脱敏）。 */
export const ProviderDescriptor = z.object({
  provider_id: z.string().min(1).max(128),
  display_name: z.string().min(1).max(256),
  kind: ProviderKind.default('custom'),
  /** 自定义 base URL —— 服务端执行 URL 解析/scheme/host/SSRF 校验（fail closed）。 */
  base_url: z.string().min(1).max(2048),
  enabled: z.boolean().default(true),
  capabilities: z.array(ProviderCapability).min(1).default(['chat']),
  models: z.array(ProviderModel).default([]),
  revision: z.number().int().positive().default(1),
  /** Optional for providers/modes that do not authenticate (for example MinerU Flash). */
  credential: SecretRef.optional(),
  /** 创建者（instance 级管理面；响应不包含 secret 值）。 */
  created_by: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
}).strict()
export type ProviderDescriptor = z.infer<typeof ProviderDescriptor>

/** Provider 创建输入（credential 只能是 SecretRef 元数据）。 */
export const ProviderCreateInput = z.object({
  provider_id: z.string().min(1).max(128),
  display_name: z.string().min(1).max(256),
  kind: ProviderKind.optional(),
  base_url: z.string().min(1).max(2048),
  enabled: z.boolean().optional(),
  capabilities: z.array(ProviderCapability).min(1).default(['chat']),
  models: z.array(z.object({
    model_id: z.string().min(1).max(256),
    display_name: z.string().max(256).optional(),
    capabilities: z.array(ProviderCapability).min(1).default(['chat']),
  }).strict()).default([]),
  /** Optional for no-auth providers; precision modes can attach a server-side SecretRef. */
  credential: SecretRef.optional(),
}).strict()
export type ProviderCreateInput = z.infer<typeof ProviderCreateInput>

/** Provider 更新输入（revision CAS；全字段可选，未知键拒绝）。 */
export const ProviderUpdateInput = z.object({
  expected_revision: z.number().int().positive(),
  display_name: z.string().min(1).max(256).optional(),
  kind: ProviderKind.optional(),
  base_url: z.string().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
  capabilities: z.array(ProviderCapability).min(1).optional(),
  models: z.array(z.object({
    model_id: z.string().min(1).max(256),
    display_name: z.string().max(256).optional(),
    capabilities: z.array(ProviderCapability).min(1).default(['chat']),
  }).strict()).optional(),
  /** null explicitly removes the current SecretRef; omission preserves it. */
  credential: SecretRef.nullable().optional(),
}).strict()
export type ProviderUpdateInput = z.infer<typeof ProviderUpdateInput>

/** 项目绑定 purpose（模型能力用途）。 */
export const BindingPurpose = z.enum(['chat', 'ocr', 'vision'])
export type BindingPurpose = z.infer<typeof BindingPurpose>

/**
 * 项目 Model Binding —— 项目只提交 opaque provider_id/model_id + purpose
 * （init-grill-upload-models.md §4；api-contracts.md §19 model-bindings）。
 * 服务端校验 provider 存在且 enabled、模型在 provider 目录、provider 声明
 * 匹配 purpose 的能力，并快照 provider_revision + config_hash（运行中任务
 * 固定创建时 revision/hash）。
 */
export const ProjectModelBinding = z.object({
  project_id: z.string().min(1),
  purpose: BindingPurpose,
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  provider_revision: z.number().int().positive(),
  provider_config_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** 绑定自身 revision（变更 CAS）。 */
  revision: z.number().int().nonnegative().default(0),
  updated_by: z.string().default(''),
  updated_at: z.string(),
}).strict()
export type ProjectModelBinding = z.infer<typeof ProjectModelBinding>

/** 项目绑定请求（只允许 opaque ID；拒绝 endpoint/credential/参数）。 */
export const ProjectModelBindingInput = z.object({
  purpose: BindingPurpose,
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  /** Pins the exact provider revision selected by the configuration writer. */
  expected_provider_revision: z.number().int().positive().optional(),
  /** 绑定 CAS：缺省时允许覆盖（首个绑定 revision=0）。 */
  expected_revision: z.number().int().nonnegative().optional(),
}).strict()
export type ProjectModelBindingInput = z.infer<typeof ProjectModelBindingInput>

/** 稳定错误码（MODEL-01 provider 注册表）。 */
export const PROVIDER_ERROR_CODES = [
  'provider_unknown',
  'provider_exists',
  'provider_revision_conflict',
  'provider_disabled',
  'provider_contract_invalid',
  'provider_credential_required',
  'provider_credential_corrupt',
  'model_unknown',
  'provider_capability_missing',
  'provider_url_scheme_invalid',
  'provider_url_userinfo_rejected',
  'provider_url_ssrf_rejected',
  'provider_url_malformed',
  'secret_value_forbidden',
  'secret_ref_invalid',
  'binding_revision_conflict',
] as const
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number]
