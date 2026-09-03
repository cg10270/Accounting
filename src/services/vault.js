import crypto from 'node:crypto';
import { config, vaultEnabled } from '../config.js';

// Zugangsdaten werden nie im Klartext gespeichert. Der Schluessel wird aus der
// Master-Passphrase abgeleitet und existiert nur im Prozessspeicher.
const SALT = 'accounting-prep/vault/v1';
let cachedKey = null;

function key() {
  if (!vaultEnabled) throw new Error('VAULT_PASSPHRASE ist nicht gesetzt - Zugangsdaten koennen nicht verarbeitet werden.');
  if (!cachedKey) cachedKey = crypto.scryptSync(config.vaultPassphrase, SALT, 32);
  return cachedKey;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// Secrets verlassen den Server nur maskiert. Die Oberflaeche sieht nie ein Passwort.
export function maskSecret(payload) {
  return payload ? '••••••••' : '';
}

// Fuer Log- und Prompt-Ausgaben: bekannte Geheimnisse aus einem Text entfernen.
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDIGIERT]');
  }
  return out;
}

export { vaultEnabled };
