'use strict';

let client = null;

function configured() {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID);
}

function getClient() {
  if (!configured()) return null;
  if (client) return client;
  const Cloudflare = require('cloudflare');
  client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });
  return client;
}

function normalizeRecord(input = {}) {
  const type = String(input.type || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const content = String(input.content || '').trim();
  const ttl = Number(input.ttl || 1);
  const proxied = input.proxied == null ? undefined : Boolean(input.proxied);
  if (!['A', 'AAAA', 'CNAME', 'TXT'].includes(type)) throw new Error('unsupported record type');
  if (!name || !content) throw new Error('name and content required');
  return { type, name, content, ttl, proxied };
}

async function listRecords() {
  const cf = getClient();
  if (!cf) return null;
  return cf.dns.records.list({ zone_id: process.env.CLOUDFLARE_ZONE_ID });
}

async function upsertRecord(input) {
  const cf = getClient();
  if (!cf) return null;
  const record = normalizeRecord(input);
  const existing = await cf.dns.records.list({
    zone_id: process.env.CLOUDFLARE_ZONE_ID,
    type: record.type,
    name: record.name,
  });
  const found = existing.result?.[0];
  if (found) {
    return cf.dns.records.update(found.id, {
      zone_id: process.env.CLOUDFLARE_ZONE_ID,
      ...record,
    });
  }
  return cf.dns.records.create({
    zone_id: process.env.CLOUDFLARE_ZONE_ID,
    ...record,
  });
}

module.exports = {
  configured,
  listRecords,
  upsertRecord,
};
