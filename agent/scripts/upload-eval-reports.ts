import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobNotFoundError, head, put } from "@vercel/blob";

import {
  blobPathname,
  contentTypeFor,
  defaultBlobPrefix,
  listReportFiles,
} from "../evals/lib/upload.ts";

const reportsDir =
  process.env.SAGE_EVAL_REPORTS ??
  join(fileURLToPath(new URL("../evals/reports", import.meta.url)));
const prefix = process.env.SAGE_EVAL_BLOB_PREFIX ?? defaultBlobPrefix;
const access: "private" | "public" =
  process.env.SAGE_EVAL_BLOB_ACCESS === "public" ? "public" : "private";

async function main(): Promise<void> {
  const files = listReportFiles(reportsDir);
  if (files.length === 0) {
    console.log("No eval reports to upload.");
    return;
  }

  requireCredentials();

  let uploaded = 0;
  let skipped = 0;
  for (const filePath of files) {
    const pathname = blobPathname(filePath, prefix);
    if (await blobExists(pathname)) {
      console.log(`skip ${pathname}`);
      skipped += 1;
      continue;
    }
    const body = readFileSync(filePath);
    const result = await put(pathname, body, {
      access,
      addRandomSuffix: false,
      contentType: contentTypeFor(filePath),
      multipart: body.length > 4 * 1024 * 1024,
    });
    console.log(`uploaded ${result.pathname}`);
    uploaded += 1;
  }
  console.log(`Done. uploaded=${uploaded} skipped=${skipped}`);
}

function requireCredentials(): void {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = process.env.BLOB_STORE_ID;
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  if (
    (token !== undefined && token.length > 0) ||
    (storeId !== undefined &&
      storeId.length > 0 &&
      oidc !== undefined &&
      oidc.length > 0)
  ) {
    return;
  }
  throw new Error(
    "Set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID and VERCEL_OIDC_TOKEN from a connected Vercel Blob store."
  );
}

async function blobExists(pathname: string): Promise<boolean> {
  try {
    await head(pathname);
    return true;
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return false;
    }
    throw error;
  }
}

await main();
