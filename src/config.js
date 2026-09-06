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
  // Ueberschreibbar, damit Tests gegen eine eigene Datenbank laufen koennen.
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'accounting.sqlite'),

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

  // ---- Browser-Steuerung ----
  // Bestehendes Chrome ueber das Debug-Protokoll uebernehmen (Anmeldungen
  // bleiben erhalten), sonst eigenes Profilverzeichnis starten.
  chromeCdpUrl: process.env.CHROME_CDP_URL || '',
  chromeProfilDir: process.env.CHROME_PROFIL_DIR || path.join(ROOT, 'data', 'chrome-profil'),
  chromeExecutable: process.env.CHROME_EXECUTABLE || '',
  browserSichtbar: process.env.BROWSER_SICHTBAR !== '0',
  // Harte Obergrenzen: ein Agent mit angemeldetem Browser darf nicht endlos laufen.
  agentMaxSchritte: Number(process.env.AGENT_MAX_SCHRITTE || 40),
  agentMaxSekunden: Number(process.env.AGENT_MAX_SEKUNDEN || 600),
  // Zusaetzlich erlaubte Domains, kommagetrennt. Die Domains der hinterlegten
  // Zugaenge sind immer erlaubt.
  agentZusatzDomains: (process.env.AGENT_ERLAUBTE_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean),

  mailDriver: process.env.MAIL_DRIVER || 'mock',

  // ---- IMAP und SMTP (fuer MAIL_DRIVER=imap) ----
  // Die Vorgaben passen fuer Google Workspace; als Passwort dient ein
  // App-Passwort, nicht das Kontopasswort.
  imapHost: process.env.IMAP_HOST || 'imap.gmail.com',
  imapPort: Number(process.env.IMAP_PORT || 993),
  imapUser: process.env.IMAP_USER || '',
  imapPasswort: process.env.IMAP_PASSWORT || process.env.IMAP_PASSWORD || '',
  imapPostfach: process.env.IMAP_POSTFACH || 'INBOX',
  imapTimeoutMs: Number(process.env.IMAP_TIMEOUT_MS || 15000),
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
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
