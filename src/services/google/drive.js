import { config } from '../../config.js';
import { googleAbruf, SCOPES } from './auth.js';

// Zugriff auf Google Drive ueber die REST-Schnittstelle.
//
// Drive kennt keine Pfade, sondern nur Ordner-IDs. Ein Pfad wie
// "Buchhaltung/2026/08 August/Belege" wird deshalb Ebene fuer Ebene aufgeloest
// und dabei angelegt, was noch fehlt. Die gefundenen IDs werden gemerkt, damit
// nicht bei jedem Upload erneut gesucht wird.

const ORDNER_TYP = 'application/vnd.google-apps.folder';
// Ab dieser Groesse wird der wiederaufnehmbare Upload verwendet; der einfache
// Multipart-Upload ist bei Google auf 5 MB begrenzt.
const MULTIPART_GRENZE = 5 * 1024 * 1024;

const ordnerCache = new Map();

// In Drive-Suchausdruecken werden Backslash und einfaches Anfuehrungszeichen maskiert.
const maskiere = (wert) => String(wert).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Fuer geteilte Ablagen ("Shared Drives") muessen beide Schalter gesetzt sein.
const gemeinsameAblagen = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

function url(basis, pfad, parameter = {}) {
  const u = new URL(basis + pfad);
  for (const [k, v] of Object.entries(parameter)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

async function finde(name, elternId) {
  const q = `name = '${maskiere(name)}' and '${maskiere(elternId)}' in parents and trashed = false`;
  const ergebnis = await googleAbruf(
    url(config.driveApi, '/files', { q, fields: 'files(id,name,mimeType)', pageSize: '10', ...gemeinsameAblagen }),
    { scopes: SCOPES.drive },
  );
  return ergebnis.files?.[0] || null;
}

async function legeOrdnerAn(name, elternId) {
  return googleAbruf(url(config.driveApi, '/files', { fields: 'id,name', ...gemeinsameAblagen }), {
    scopes: SCOPES.drive,
    methode: 'POST',
    kopfzeilen: { 'Content-Type': 'application/json' },
    koerper: JSON.stringify({ name, mimeType: ORDNER_TYP, parents: [elternId] }),
  });
}

/**
 * Loest einen Ordnerpfad in eine Drive-ID auf und legt fehlende Ebenen an.
 */
export async function ordnerId(ordnerPfad) {
  if (!config.driveRootFolderId) {
    throw new Error('DRIVE_ROOT_FOLDER_ID ist nicht gesetzt - ohne Zielordner kann nichts abgelegt werden.');
  }
  const teile = String(ordnerPfad).split('/').filter(Boolean);
  let aktuelle = config.driveRootFolderId;
  let gelaufen = '';

  for (const teil of teile) {
    gelaufen = gelaufen ? `${gelaufen}/${teil}` : teil;
    const gemerkt = ordnerCache.get(gelaufen);
    if (gemerkt) { aktuelle = gemerkt; continue; }

    let ordner = await finde(teil, aktuelle);
    if (ordner && ordner.mimeType && ordner.mimeType !== ORDNER_TYP) {
      throw new Error(`In Drive existiert "${gelaufen}" bereits als Datei, nicht als Ordner.`);
    }
    if (!ordner) ordner = await legeOrdnerAn(teil, aktuelle);

    ordnerCache.set(gelaufen, ordner.id);
    aktuelle = ordner.id;
  }
  return aktuelle;
}

/**
 * Legt eine Datei ab. Existiert im Zielordner bereits eine Datei gleichen
 * Namens, wird deren Inhalt ersetzt - so entstehen bei einem zweiten Lauf
 * keine Dubletten.
 */
export async function ablegen(ordnerPfad, dateiname, buffer, mime = 'application/octet-stream') {
  const elternId = await ordnerId(ordnerPfad);
  const vorhanden = await finde(dateiname, elternId);

  const felder = 'id,name,webViewLink,size';
  const gross = buffer.length > MULTIPART_GRENZE;

  if (gross) return uploadWiederaufnehmbar({ elternId, dateiname, buffer, mime, vorhandenId: vorhanden?.id, felder });

  // Multipart: Metadaten und Inhalt in einem Rumpf, getrennt durch eine Grenzmarke.
  const grenze = `grenze_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const metadaten = vorhanden ? { name: dateiname } : { name: dateiname, parents: [elternId] };
  const koerper = Buffer.concat([
    Buffer.from(
      `--${grenze}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadaten)}\r\n--${grenze}\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${grenze}--\r\n`),
  ]);

  const ergebnis = await googleAbruf(
    url(config.driveUploadApi, vorhanden ? `/files/${vorhanden.id}` : '/files',
      { uploadType: 'multipart', fields: felder, supportsAllDrives: 'true' }),
    {
      scopes: SCOPES.drive,
      methode: vorhanden ? 'PATCH' : 'POST',
      kopfzeilen: { 'Content-Type': `multipart/related; boundary=${grenze}` },
      koerper,
    },
  );
  return { id: ergebnis.id, name: ergebnis.name, webUrl: ergebnis.webViewLink || '' };
}

async function uploadWiederaufnehmbar({ elternId, dateiname, buffer, mime, vorhandenId, felder }) {
  const metadaten = vorhandenId ? { name: dateiname } : { name: dateiname, parents: [elternId] };

  const start = await googleAbruf(
    url(config.driveUploadApi, vorhandenId ? `/files/${vorhandenId}` : '/files',
      { uploadType: 'resumable', fields: felder, supportsAllDrives: 'true' }),
    {
      scopes: SCOPES.drive,
      methode: vorhandenId ? 'PATCH' : 'POST',
      kopfzeilen: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(buffer.length),
      },
      koerper: JSON.stringify(metadaten),
      roh: true,
    },
  );

  const ziel = start.headers.get('location');
  if (!ziel) throw new Error('Google hat keine Upload-Adresse zurückgegeben.');

  // Das Zugriffstoken gehoert auch an den Upload selbst: die Sitzungsadresse
  // allein reicht nicht als Nachweis.
  const ergebnis = await googleAbruf(ziel, {
    scopes: SCOPES.drive,
    methode: 'PUT',
    kopfzeilen: { 'Content-Type': mime, 'Content-Length': String(buffer.length) },
    koerper: buffer,
  });
  return { id: ergebnis.id, name: ergebnis.name, webUrl: ergebnis.webViewLink || '' };
}

export async function herunterladen(dateiId) {
  const antwort = await googleAbruf(
    url(config.driveApi, `/files/${dateiId}`, { alt: 'media', supportsAllDrives: 'true' }),
    { scopes: SCOPES.drive, roh: true },
  );
  return Buffer.from(await antwort.arrayBuffer());
}

export async function findeDatei(ordnerPfad, dateiname) {
  const elternId = await ordnerId(ordnerPfad);
  return finde(dateiname, elternId);
}

/**
 * Verschiebt eine Datei in den Papierkorb statt sie endgueltig zu loeschen -
 * eine versehentlich entfernte Rechnung bleibt so wiederherstellbar.
 */
export async function inPapierkorb(dateiId) {
  await googleAbruf(url(config.driveApi, `/files/${dateiId}`, { supportsAllDrives: 'true' }), {
    scopes: SCOPES.drive,
    methode: 'PATCH',
    kopfzeilen: { 'Content-Type': 'application/json' },
    koerper: JSON.stringify({ trashed: true }),
  });
}

export async function inhaltVon(ordnerPfad) {
  const elternId = await ordnerId(ordnerPfad);
  const ergebnis = await googleAbruf(
    url(config.driveApi, '/files', {
      q: `'${maskiere(elternId)}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size)', pageSize: '1000', ...gemeinsameAblagen,
    }),
    { scopes: SCOPES.drive },
  );
  return (ergebnis.files || []).map((f) => ({
    name: f.name, isFolder: f.mimeType === ORDNER_TYP, id: f.id, size: Number(f.size || 0),
  }));
}

// Prueft die Einrichtung: Token, Zugriff auf den Zielordner, Schreibrecht.
export async function pruefeEinrichtung() {
  let ordner;
  try {
    ordner = await googleAbruf(
      url(config.driveApi, `/files/${config.driveRootFolderId}`,
        { fields: 'id,name,mimeType,driveId', supportsAllDrives: 'true' }),
      { scopes: SCOPES.drive },
    );
  } catch (err) {
    // 404 heisst hier fast nie "gibt es nicht", sondern "fuer dieses Postfach
    // nicht sichtbar" - Drive verbirgt Nichtfreigegebenes.
    if (/\(404\)/.test(err.message)) {
      throw new Error(
        `Der Ordner mit der ID ${config.driveRootFolderId} ist für ${config.googleImpersonateUser} nicht sichtbar. ` +
        'Entweder stimmt DRIVE_ROOT_FOLDER_ID nicht (die ID steht in der Adresszeile hinter /folders/), ' +
        'oder der Ordner ist für dieses Postfach nicht freigegeben.',
      );
    }
    throw err;
  }
  if (ordner.mimeType !== ORDNER_TYP) {
    throw new Error(`DRIVE_ROOT_FOLDER_ID zeigt auf "${ordner.name}", das ist kein Ordner.`);
  }
  return { id: ordner.id, name: ordner.name, geteilteAblage: Boolean(ordner.driveId) };
}

export function _cacheLeeren() { ordnerCache.clear(); }
