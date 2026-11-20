'use strict';

// Criptografia simétrica (AES-256-GCM) para guardar segredos que não podem
// ficar em texto puro no banco — hoje, os tokens do GitHub dos usuários.

const crypto = require('crypto');

function key() {
  const secret = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || 'hostfy-insecure-default';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plain) {
  if (plain === undefined || plain === null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts[0] !== 'v1' || parts.length !== 4) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };