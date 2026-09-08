/**
 * Where encoded photos are published.
 *
 * A target implements put(key, bytes, contentType), remove(keys) and carries
 * the `base` the pages prefix onto every photo URL. The pipeline never learns
 * which one it is talking to.
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * A directory in the repo, served by GitHub Pages
 * ------------------------------------------------------------------ */

export function localTarget({ dir, base = "/gallery/photos" }) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    name: `local:${dir}`,
    base,
    async put(key, bytes) {
      await fs.promises.writeFile(path.join(dir, key), bytes);
    },
    async remove(keys) {
      for (const key of keys) {
        await fs.promises.rm(path.join(dir, key), { force: true });
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Cloudflare R2, over its S3-compatible API
 * ------------------------------------------------------------------ */

const AWS_ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * Minimal SigV4 for the three calls this tool makes. R2 wants the payload
 * hash on every request, so nothing here streams — the objects are small
 * enough that holding one in memory is fine.
 */
async function signedFetch({ accountId, accessKeyId, secretAccessKey, bucket }, method, key, body, contentType) {
  const crypto = await import("node:crypto");
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(contentType ? { "content-type": contentType } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join("");

  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  let signingKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  for (const part of [region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: {
      ...headers,
      authorization:
        `${AWS_ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: method === "PUT" ? payload : undefined,
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`r2 ${method} ${key} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return res;
}

export function r2Target({ accountId, accessKeyId, secretAccessKey, bucket, prefix = "", base, endpoint }) {
  if (!base) throw new Error("r2 target needs the public base URL photos are served from");
  const creds = { accountId, accessKeyId, secretAccessKey, bucket };
  const withPrefix = (key) => (prefix ? `${prefix.replace(/\/$/, "")}/${key}` : key);

  // Pointed at a stub, requests go out unsigned; only the real endpoint signs.
  const call = endpoint
    ? async (method, key, body, contentType) => {
        const res = await fetch(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`, {
          method,
          headers: contentType ? { "content-type": contentType } : {},
          body: method === "PUT" ? body : undefined,
        });
        if (!res.ok && !(method === "DELETE" && res.status === 404)) {
          throw new Error(`r2 stub ${method} ${key} -> ${res.status}`);
        }
        return res;
      }
    : (method, key, body, contentType) => signedFetch(creds, method, key, body, contentType);

  return {
    name: `r2:${bucket}${prefix ? "/" + prefix : ""}`,
    base: base.replace(/\/$/, ""),
    async put(key, bytes, contentType) {
      await call("PUT", withPrefix(key), bytes, contentType);
    },
    async remove(keys) {
      for (const key of keys) await call("DELETE", withPrefix(key));
    },
  };
}
