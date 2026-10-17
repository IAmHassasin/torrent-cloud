import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    TC_API_TOKEN: z.string().min(24, 'TC_API_TOKEN must be at least 24 characters'),
    ARIA2_RPC_URL: z.url().default('http://aria2:6800/jsonrpc'),
    ARIA2_RPC_SECRET: z.string().min(16, 'ARIA2_RPC_SECRET must be at least 16 characters'),
    DOWNLOAD_DIR: z.string().default('/downloads'),
    DATA_DIR: z.string().default('/data'),
    STORAGE_PROVIDER: z.enum(['s3', 'local']).default('s3'),
    S3_ENDPOINT: z.string().optional(),
    S3_PUBLIC_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('torrent-cloud'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    LINK_TTL_SEC: z.coerce.number().int().min(60).max(604800).default(86400),
    PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
    LOCAL_LINK_SECRET: z.string().optional(),
    KEEP_LOCAL: bool,
    MAX_TORRENT_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
    POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.STORAGE_PROVIDER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for s3` });
      }
    }
    if (cfg.STORAGE_PROVIDER === 'local' && (cfg.LOCAL_LINK_SECRET ?? '').length < 24) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_LINK_SECRET'],
        message: 'LOCAL_LINK_SECRET (24+ chars) is required for local storage',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Only field names and messages are printed, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
