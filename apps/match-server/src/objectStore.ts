// Minimal object-store seam for match persistence mirroring. The S3
// implementation is the only production backend; the in-memory one exists so
// mirroring and hydration are testable without AWS.
import {
  GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';

export interface ObjectStore {
  put(key: string, body: string): Promise<void>;
  /** null when the key does not exist */
  get(key: string): Promise<string | null>;
  /** all keys under the prefix (paginated internally) */
  list(prefix: string): Promise<string[]>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, string>();
  async put(key: string, body: string): Promise<void> { this.objects.set(key, body); }
  async get(key: string): Promise<string | null> { return this.objects.get(key) ?? null; }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
  }
}

export class S3ObjectStore implements ObjectStore {
  constructor(private bucket: string, private client: S3Client = new S3Client({})){}

  async put(key: string, body: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentType: key.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json',
    }));
  }

  async get(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? await res.Body.transformToString('utf8') : null;
    } catch (err){
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken: token,
      }));
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
