'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let client = null;

function configured() {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID
      && process.env.R2_ACCESS_KEY_ID
      && process.env.R2_SECRET_ACCESS_KEY
      && process.env.R2_BUCKET
  );
}

function getClient() {
  if (!configured()) return null;
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

async function putObject(key, body, contentType = 'application/octet-stream') {
  const s3 = getClient();
  if (!s3 || !key) return false;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return true;
}

function backupKey(name) {
  const safeName = String(name || 'backup').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const date = new Date().toISOString().slice(0, 10);
  return `${String(process.env.R2_PREFIX || 'pc-off').replace(/\/+$/, '')}/${date}/${safeName}`;
}

module.exports = {
  configured,
  putObject,
  backupKey,
};
