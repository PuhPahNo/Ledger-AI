import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../config/env.js';

export interface StoredObject {
  key: string;
  url?: string;
}

export interface StoragePutInput {
  key: string;
  body: Buffer | Readable;
  contentType?: string;
}

export interface StorageDriver {
  put(input: StoragePutInput): Promise<StoredObject>;
  getStream(key: string): Promise<Readable>;
  getSignedDownloadUrl(key: string, fileName?: string): Promise<string>;
}

export function storage(): StorageDriver {
  const env = getEnv();
  return env.STORAGE_DRIVER === 'r2' ? new R2Storage() : new LocalStorage();
}

class LocalStorage implements StorageDriver {
  private root = getEnv().LOCAL_STORAGE_DIR;

  async put(input: StoragePutInput): Promise<StoredObject> {
    const target = path.join(this.root, input.key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const body = input.body;
    if (Buffer.isBuffer(body)) {
      await fsp.writeFile(target, body);
    } else {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createWriteStream(target);
        body.pipe(stream);
        body.on('error', reject);
        stream.on('error', reject);
        stream.on('finish', resolve);
      });
    }
    return { key: input.key, url: `/api/files/${encodeURIComponent(input.key)}` };
  }

  async getStream(key: string): Promise<Readable> {
    return fs.createReadStream(path.join(this.root, key));
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    return `/api/files/${encodeURIComponent(key)}`;
  }
}

class R2Storage implements StorageDriver {
  private env = getEnv();
  private client = new S3Client({
    region: 'auto',
    endpoint: this.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: this.env.R2_ACCESS_KEY_ID,
      secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
    },
  });

  async put(input: StoragePutInput): Promise<StoredObject> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.env.R2_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }));
    return { key: input.key };
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.env.R2_BUCKET, Key: key }));
    if (!res.Body || !(res.Body instanceof Readable)) {
      throw new Error(`R2 object ${key} did not return a readable stream`);
    }
    return res.Body;
  }

  async getSignedDownloadUrl(key: string, fileName?: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.env.R2_BUCKET,
      Key: key,
      ResponseContentDisposition: fileName ? `attachment; filename="${fileName}"` : undefined,
    }), { expiresIn: 60 * 10 });
  }
}
