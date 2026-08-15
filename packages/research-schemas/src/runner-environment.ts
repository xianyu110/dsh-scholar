/** Typed Docker runtime configuration shared by Target, Job and ExecutionPlan. */
import { z } from 'zod'

export const DOCKER_IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

const NvidiaDeviceList = z.array(z.string().regex(/^(0|[1-9][0-9]*)$/))
  .min(1)
  .max(64)
  .superRefine((devices, ctx) => {
    if (new Set(devices).size !== devices.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NVIDIA device ids must be unique' })
    }
  })
  .transform(devices => [...devices].sort((left, right) => Number(left) - Number(right)))

export const DockerCompute = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('cpu') }).strict(),
  z.object({
    mode: z.literal('nvidia'),
    devices: z.union([z.literal('all'), NvidiaDeviceList]),
  }).strict(),
])
export type DockerCompute = z.infer<typeof DockerCompute>

export const DockerRuntime = z.object({
  image_digest: z.string().regex(DOCKER_IMAGE_DIGEST_RE, 'Docker image must be <repository>@sha256:<64 hex>'),
  compute: DockerCompute,
}).strict()
export type DockerRuntime = z.infer<typeof DockerRuntime>

export function dockerGpuArgument(compute: DockerCompute): string | null {
  if (compute.mode === 'cpu') return null
  return compute.devices === 'all' ? 'all' : `device=${compute.devices.join(',')}`
}
