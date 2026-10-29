// Generated creatives (Muse Image). S3 in AWS, local folder in dev.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const LOCAL_DIR = process.env.LOCAL_ASSETS_DIR || "data/assets";

export async function putAsset(key, buffer, contentType = "image/png") {
  if (!process.env.ASSETS_BUCKET) {
    const p = join(LOCAL_DIR, key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buffer);
    return key;
  }
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  await new S3Client({}).send(
    new PutObjectCommand({ Bucket: process.env.ASSETS_BUCKET, Key: key, Body: buffer, ContentType: contentType }),
  );
  return key;
}

export async function getAsset(key) {
  if (!/^[\w\-/.]+$/.test(key) || key.includes("..")) return null;
  if (!process.env.ASSETS_BUCKET) {
    const p = join(LOCAL_DIR, key);
    return existsSync(p) ? { body: readFileSync(p), contentType: "image/png" } : null;
  }
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    const res = await new S3Client({}).send(new GetObjectCommand({ Bucket: process.env.ASSETS_BUCKET, Key: key }));
    return { body: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType || "image/png" };
  } catch {
    return null;
  }
}
