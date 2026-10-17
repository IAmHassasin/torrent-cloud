import { join } from 'node:path';
import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import type { StorageProvider } from './provider.js';
import { S3Storage } from './s3.js';

export type { StorageProvider } from './provider.js';
export { LocalStorage } from './local.js';

export function createStorage(config: Config): StorageProvider {
  if (config.STORAGE_PROVIDER === 'local') {
    return new LocalStorage(join(config.DATA_DIR, 'files'), config.PUBLIC_BASE_URL, config.LOCAL_LINK_SECRET!);
  }
  return new S3Storage({
    endpoint: config.S3_ENDPOINT!,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}
