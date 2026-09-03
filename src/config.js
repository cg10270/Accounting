import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Minimaler .env-Loader: keine Abhaengigkeit, gleiche Semantik wie dotenv.
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile();

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '127.0.0.1',

  dataDir: path.join(ROOT, 'data'),
  dbFile: path.join(ROOT, 'data', 'accounting.sqlite'),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: 'claude-opus-5',

  vaultPassphrase: process.env.VAULT_PASSPHRASE || '',

  storageDriver: process.env.STORAGE_DRIVER || 'local',
  localStorageDir: path.join(ROOT, 'data', 'drive'),
  driveRootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || '',
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  googleImpersonateUser: process.env.GOOGLE_IMPERSONATE_USER || '',
  // Endpunkte sind ueberschreibbar, damit die Anbindung gegen einen
  // Testserver geprueft werden kann, ohne echte Google-Konten zu beruehren.
  driveApi: process.env.GOOGLE_DRIVE_API || 'https://www.googleapis.com/drive/v3',
  driveUploadApi: process.env.GOOGLE_DRIVE_UPLOAD_API || 'https://www.googleapis.com/upload/drive/v3',
  gmailApi: process.env.GOOGLE_GMAIL_API || 'https://gmail.googleapis.com/gmail/v1',

  mailDriver: process.env.MAIL_DRIVER || 'mock',
  outboxDir: path.join(ROOT, 'data', 'outbox'),
  mailFrom: process.env.MAIL_FROM || 'accounting@lexaid.net',
  accountingInbox: process.env.ACCOUNTING_INBOX || 'accounting@lexaid.net',
  shortcodeDomain: process.env.SHORTCODE_DOMAIN || 'lexaid.net',
};

for (const dir of [config.dataDir, config.localStorageDir, config.outboxDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const aiEnabled = Boolean(config.anthropicApiKey);
export const vaultEnabled = Boolean(config.vaultPassphrase);
