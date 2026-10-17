import { createReadStream } from 'node:fs';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDisposition, type StorageProvider, type UploadProgress } from './provider.js';

export interface S3Options {
  endpoint: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Any S3-compatible backend: SeaweedFS/MinIO locally, AWS S3, Cloudflare R2, Backblaze B2... */
export class S3Storage implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;
  /** Signs links for the endpoint the downloader can reach (may differ from the internal one). */
  private readonly signer: S3Client;

  constructor(private readonly options: S3Options) {
    const base = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.signer = new S3Client({ ...base, endpoint: options.publicEndpoint || options.endpoint });
  }

  async init(): Promise<void> {
    const Bucket = this.options.bucket;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      // Buckets are private by default; links are always presigned.
      await this.client.send(new CreateBucketCommand({ Bucket }));
    }
  }

  async put(localPath: string, key: string, _size: number, onProgress?: UploadProgress): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.options.bucket, Key: key, Body: createReadStream(localPath) },
      partSize: 16 * 1024 * 1024,
      queueSize: 4,
    });
    if (onProgress) upload.on('httpUploadProgress', (p) => p.loaded !== undefined && onProgress(p.loaded));
    await upload.done();
  }

  link(key: string, fileName: string, ttlSec: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(fileName),
    });
    return getSignedUrl(this.signer, command, { expiresIn: ttlSec });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}
