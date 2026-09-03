// Oberflaeche der Buchhaltungsvorbereitung. Bewusst ohne Framework:
// der Zustand ist klein und wird nach jeder Aenderung neu vom Server geholt.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const zustand = {
  perioden: [],
  periodeId: null,
  aufgaben: [],
  aufgabeId: null,
  status: null,
  gruppen: [],
  // Protokoll des letzten KI-Laufs, damit es ein Neuzeichnen der
  // Detailansicht ueberlebt - sonst verschwindet das Ergebnis genau dann,
  // wenn der Lauf fertig ist.
  lauf: { taskId: null, schritte: [] },
};

// --- Hilfen -----------------------------------------------------------------

async function api(pfad, optionen = {}) {
  const antwort = await fetch(pfad, optionen);
  const typ = antwort.headers.get('content-type') || '';
  const daten = typ.includes('json') ? await antwort.json() : await antwort.text();
  if (!antwort.ok) throw new Error(daten?.fehler || `Fehler ${antwort.status}`);
  return daten;
}
const holen = (p) => api(p);
const senden = (p, daten, methode = 'POST') =>
  api(p, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(daten) });

let hinweisTimer;
function melde(text, art = 'info') {
  const el = $('#hinweis');
  el.textContent = text;
  el.className = art;
  el.style.display = 'block';
  clearTimeout(hinweisTimer);
  hinweisTimer = setTimeout(() => { el.style.display = 'none'; }, art === 'fehler' ? 9000 : 4000);
}
const fehlerBehandeln = (err) => melde(err.message || String(err), 'fehler');

const euro = (cents) => (Number(cents || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const datumDe = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const zuCents = (wert) => Math.round(Number(String(wert).replace(',', '.') || 0) * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_TEXT = { offen: 'Offen', in_arbeit: 'In Arbeit', wartet: 'Wartet', erledigt: 'Erledigt' };

// --- Start ------------------------------------------------------------------

async function start() {
  try {
    zustand.status = await holen('/api/status');
    zeigeStatus();
    await ladePerioden();
  } catch (err) { fehlerBehandeln(err); }
}

function zeigeStatus() {
  const s = zustand.status;
  $('#systemstatus').innerHTML = [
    `<span class="chip ${s.ki.aktiv ? 'an' : 'aus'}">KI: ${s.ki.aktiv ? s.ki.modell : 'Mock-Modus'}</span>`,
    `<span class="chip ${s.tresor.aktiv ? 'an' : 'aus'}">Tresor: ${s.tresor.aktiv ? 'aktiv' : 'inaktiv'}</span>`,
    `<span class="chip ${s.ablage.ready ? 'an' : 'aus'}">Ablage: ${s.ablage.driver}</span>`,
    `<span class="chip ${s.mail.ready ? 'an' : 'aus'}">Mail: ${s.mail.driver}</span>`,
  ].join('');
  $('#status-details').textContent = JSON.stringify(s, null, 2);
  $('#kuerzel-domain').textContent = s.kuerzel_domain;
}

async function ladePerioden() {
  zustand.perioden = await holen('/api/periods');
  const wahl = $('#periodenwahl');
  if (!zustand.perioden.length) {
    wahl.innerHTML = '<option value="">Kein Zeitraum angelegt</option>';
    $('#aufgabenliste').innerHTML = '';
    $('#aufgabendetail').innerHTML = '<div class="leer">Lege oben rechts einen Zeitraum an.</div>';
    return;
  }
  wahl.innerHTML = zustand.perioden
    .map((p) => `<option value="${p.id}">${esc(p.label)} ${p.year} — ${p.erledigt}/${p.aufgaben} erledigt</option>`)
    .join('');
  if (!zustand.perioden.some((p) => p.id === zustand.periodeId)) zustand.periodeId = zustand.perioden[0].id;
  wahl.value = zustand.periodeId;
  await ladeAlles();
}

async function ladeAlles() {
  await ladeAufgaben();
  await Promise.all([ladeBankgruppen(), ladeLogbuch(), ladeKuerzel()]);
}

// --- Aufgaben ---------------------------------------------------------------

async function ladeAufgaben() {
  zustand.aufgaben = await holen(`/api/periods/${zustand.periodeId}/tasks`);
  if (!zustand.aufgaben.some((a) => a.id === zustand.aufgabeId)) {
    zustand.aufgabeId = zustand.aufgaben[0]?.id ?? null;
  }
  zeichneAufgabenliste();
  zeichneAufgabendetail();
  fuelleBelegAuswahl();
}

function zeichneAufgabenliste() {
  const erledigt = zustand.aufgaben.filter((a) => a.status === 'erledigt').length;
  const anteil = zustand.aufgaben.length ? (erledigt / zustand.aufgaben.length) * 100 : 0;
  $('#fortschrittsbalken').style.width = `${anteil}%`;

  $('#aufgabenliste').innerHTML = zustand.aufgaben.map((a) => `
    <li data-id="${a.id}" class="${a.id === zustand.aufgabeId ? 'gewaehlt' : ''}">
      <span class="punkt ${a.status}"></span>
      <span style="flex:1;min-width:0">
        <div class="titel">${esc(a.title)}</div>
        <div class="meta">${STATUS_TEXT[a.status]} · ${a.dateien.length} Datei(en)${a.prompt ? ' · KI-Prompt' : ''}${a.zugaenge.length ? ' · Zugang' : ''}</div>
      </span>
    </li>`).join('') || '<li class="leise" style="padding:14px">Noch keine Aufgaben.</li>';

  $$('#aufgabenliste li[data-id]').forEach((li) => {
    li.onclick = () => { zustand.aufgabeId = Number(li.dataset.id); zeichneAufgabenliste(); zeichneAufgabendetail(); };
  });
}

function zeichneAufgabendetail() {
  const a = zustand.aufgaben.find((x) => x.id === zustand.aufgabeId);
  const ziel = $('#aufgabendetail');
  if (!a) { ziel.innerHTML = '<div class="leer">Wähle links eine Aufgabe aus.</div>'; return; }

  ziel.innerHTML = `
    <h2 style="display:flex;gap:10px;align-items:center">
      <span style="flex:1">${esc(a.title)}</span>
      <span class="badge ${a.status}">${STATUS_TEXT[a.status]}</span>
    </h2>
    <div class="inhalt">
      <div class="reihe" style="margin-bottom:16px">
        <label class="reihe klein-text" style="gap:6px">
          <input type="checkbox" id="d-erledigt" ${a.status === 'erledigt' ? 'checked' : ''} style="width:auto">
          Von der Verwaltung abgehakt
        </label>
        <select id="d-status" style="width:auto">
          ${Object.entries(STATUS_TEXT).map(([w, t]) => `<option value="${w}" ${a.status === w ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        ${a.done_at ? `<span class="klein-text leise">am ${esc(a.done_at)} durch ${esc(a.done_by || '—')}</span>` : ''}
        <button class="knopf gefahr klein" id="d-loeschen" style="margin-left:auto">Aufgabe löschen</button>
      </div>

      <label class="feld"><span>Titel</span><input type="text" id="d-titel" value="${esc(a.title)}"></label>
      <label class="feld"><span>Beschreibung</span><textarea id="d-beschreibung" style="min-height:60px">${esc(a.description)}</textarea></label>
      <label class="feld"><span>KI-Prompt für diese Aufgabe</span><textarea id="d-prompt"
        placeholder="Was soll die KI hier tun? z. B.: Melde dich im Portal an, lade alle Rechnungen des Monats und lege sie im Zielordner ab.">${esc(a.prompt)}</textarea></label>
      <label class="feld"><span>Notizen</span><textarea id="d-notizen" style="min-height:50px">${esc(a.notes)}</textarea></label>
      <div class="reihe" style="margin-bottom:22px">
        <button class="knopf" id="d-speichern">Speichern</button>
        <button class="knopf leise" id="d-ki-lauf" ${a.prompt ? '' : 'disabled'}>KI-Automatisierung starten</button>
      </div>

      <h3 style="font-size:13px;margin:0 0 8px">Hochgeladene Daten</h3>
      <ul class="dateiliste">
        ${a.dateien.map((d) => `
          <li>
            <a href="/api/dateien/${d.id}/inhalt" target="_blank">${esc(d.filename)}</a>
            <span class="klein-text leise">${(d.size / 1024).toFixed(0)} kB · ${esc(d.source)}${d.amount_cents ? ' · ' + euro(d.amount_cents) : ''}</span>
            ${d.web_url ? `<a href="${esc(d.web_url)}" target="_blank" class="klein-text" title="In Google Drive öffnen">Drive ↗</a>` : ''}
            <span style="flex:1"></span>
            <input type="text" class="klein-text d-vendor" data-id="${d.id}" value="${esc(d.vendor)}"
                   placeholder="Zuordnung für Bankabgleich" style="width:180px">
            <input type="number" step="0.01" class="klein-text d-betrag" data-id="${d.id}"
                   value="${d.amount_cents ? (d.amount_cents / 100).toFixed(2) : ''}" placeholder="Betrag" style="width:100px">
            <button class="knopf gefahr klein d-datei-loeschen" data-id="${d.id}">×</button>
          </li>`).join('') || '<li class="leise klein-text">Noch keine Daten hochgeladen.</li>'}
      </ul>
      <div class="ablegen" id="d-ablegen" style="margin:12px 0 22px">
        Datei hierher ziehen oder klicken
        <input type="file" id="d-datei" multiple hidden>
      </div>

      <h3 style="font-size:13px;margin:0 0 8px">Zugangsinformationen</h3>
      <p class="klein-text leise" style="margin-top:0">
        Passwörter werden verschlüsselt gespeichert und nie an das Sprachmodell übergeben —
        die KI erhält nur eine Referenz und löst sie erst im Anmeldeformular auf.
      </p>
      <ul class="dateiliste">
        ${a.zugaenge.map((z) => `
          <li>
            <strong>${esc(z.label)}</strong>
            <span class="klein-text leise">${esc(z.url || '')} ${z.username ? '· ' + esc(z.username) : ''} ${z.hat_secret ? '· ••••••••' : '· kein Passwort'}${z.has_mfa ? ' · 2FA' : ''}</span>
            <span style="flex:1"></span>
            <button class="knopf gefahr klein d-zugang-loeschen" data-id="${z.id}">×</button>
          </li>`).join('') || '<li class="leise klein-text">Kein Zugang hinterlegt.</li>'}
      </ul>
      <div class="raster" style="margin-top:12px">
        <label class="feld"><span>Bezeichnung</span><input type="text" id="z-label" placeholder="Lieferantenportal"></label>
        <label class="feld"><span>URL</span><input type="text" id="z-url" placeholder="https://..."></label>
        <label class="feld"><span>Benutzer</span><input type="text" id="z-user"></label>
        <label class="feld"><span>Passwort</span><input type="password" id="z-secret" style="width:100%;padding:8px 10px;border:1px solid var(--rand);border-radius:7px;background:var(--flaeche)"></label>
      </div>
      <div class="reihe">
        <label class="reihe klein-text" style="gap:6px"><input type="checkbox" id="z-mfa" style="width:auto"> Zwei-Faktor aktiv</label>
        <button class="knopf leise klein" id="z-speichern">Zugang hinzufügen</button>
      </div>
      <div id="d-ki-ergebnis"></div>
    </div>`;

  verdrahteAufgabendetail(a);

  // Protokoll eines Laufs zu dieser Aufgabe wieder einsetzen
  if (zustand.lauf.taskId === a.id && zustand.lauf.schritte.length) {
    zeichneLaufprotokoll(a.id);
  }
}

function zeichneLaufprotokoll(taskId) {
  $('#d-ki-ergebnis').innerHTML = `
    <div class="karte" style="margin-top:18px">
      <h2>KI-Lauf</h2>
      <div class="inhalt"><ul class="lauf-schritte" id="lauf-schritte"></ul></div>
    </div>`;
  const liste = $('#lauf-schritte');
  for (const e of zustand.lauf.schritte) zeigeLaufschritt(liste, e, false);
  return liste;
}

function verdrahteAufgabendetail(a) {
  const patch = (daten) => senden(`/api/tasks/${a.id}`, daten, 'PATCH').then(ladeAufgaben).catch(fehlerBehandeln);

  $('#d-erledigt').onchange = (e) => patch({ status: e.target.checked ? 'erledigt' : 'offen' });
  $('#d-status').onchange = (e) => patch({ status: e.target.value });
  $('#d-speichern').onclick = () => patch({
    title: $('#d-titel').value.trim(),
    description: $('#d-beschreibung').value,
    prompt: $('#d-prompt').value,
    notes: $('#d-notizen').value,
  });
  $('#d-loeschen').onclick = async () => {
    if (!confirm(`Aufgabe "${a.title}" wirklich löschen?`)) return;
    try { await api(`/api/tasks/${a.id}`, { method: 'DELETE' }); zustand.aufgabeId = null; await ladeAufgaben(); }
    catch (err) { fehlerBehandeln(err); }
  };

  $('#d-ki-lauf').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Läuft …';
    zustand.lauf = { taskId: a.id, schritte: [] };
    const liste = zeichneLaufprotokoll(a.id);

    // Der Lauf kommt als Ereignisstrom - jeder Schritt wird sofort angezeigt.
    try {
      const antwort = await fetch(`/api/tasks/${a.id}/ki/lauf`, { method: 'POST' });
      if (!antwort.ok) throw new Error(`Fehler ${antwort.status}`);
      const leser = antwort.body.getReader();
      const dekoder = new TextDecoder();
      let puffer = '';

      while (true) {
        const { value, done } = await leser.read();
        if (done) break;
        puffer += dekoder.decode(value, { stream: true });
        const teile = puffer.split('\n\n');
        puffer = teile.pop();
        for (const teil of teile) {
          const zeile = teil.replace(/^data: /, '').trim();
          if (!zeile) continue;
          zeigeLaufschritt(liste, JSON.parse(zeile));
          liste.lastElementChild?.scrollIntoView({ block: 'nearest' });
        }
      }
      await ladeAufgaben();
      await ladeLogbuch();
    } catch (err) { fehlerBehandeln(err); }
    e.target.disabled = false;
    e.target.textContent = 'KI-Automatisierung starten';
  };

  // Dateiupload per Klick und per Ziehen
  const ablegen = $('#d-ablegen');
  const eingabe = $('#d-datei');
  ablegen.onclick = () => eingabe.click();
  eingabe.onchange = () => ladeDateienHoch(a.id, [...eingabe.files]);
  ablegen.ondragover = (e) => { e.preventDefault(); ablegen.classList.add('aktiv'); };
  ablegen.ondragleave = () => ablegen.classList.remove('aktiv');
  ablegen.ondrop = (e) => {
    e.preventDefault();
    ablegen.classList.remove('aktiv');
    ladeDateienHoch(a.id, [...e.dataTransfer.files]);
  };

  $$('.d-datei-loeschen').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Datei wirklich löschen?')) return;
      try { await api(`/api/dateien/${b.dataset.id}`, { method: 'DELETE' }); await ladeAufgaben(); await ladeBankgruppen(); }
      catch (err) { fehlerBehandeln(err); }
    };
  });
  const dateiPatch = (el, feld, wert) =>
    senden(`/api/dateien/${el.dataset.id}`, { [feld]: wert }, 'PATCH')
      .then(() => { ladeAufgaben(); ladeBankgruppen(); })
      .catch(fehlerBehandeln);
  $$('.d-vendor').forEach((el) => { el.onchange = () => dateiPatch(el, 'vendor', el.value.trim()); });
  $$('.d-betrag').forEach((el) => { el.onchange = () => dateiPatch(el, 'amount_cents', el.value === '' ? null : zuCents(el.value)); });

  $('#z-speichern').onclick = async () => {
    try {
      await senden(`/api/tasks/${a.id}/zugaenge`, {
        label: $('#z-label').value.trim(), url: $('#z-url').value.trim(),
        username: $('#z-user').value.trim(), secret: $('#z-secret').value,
        has_mfa: $('#z-mfa').checked,
      });
      melde('Zugang gespeichert.', 'erfolg');
      await ladeAufgaben();
    } catch (err) { fehlerBehandeln(err); }
  };
  $$('.d-zugang-loeschen').forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/zugaenge/${b.dataset.id}`, { method: 'DELETE' }); await ladeAufgaben(); }
      catch (err) { fehlerBehandeln(err); }
    };
  });
}

const SCHRITT_SYMBOL = {
  gestartet: '▸', browser: '▸', werkzeug: '·', 'überlegung': '💭',
  'beleg abgelegt': '✓', fehler: '!', abgebrochen: '!', abgeschlossen: '■',
};

function zeigeLaufschritt(liste, e, merken = true) {
  if (merken) zustand.lauf.schritte.push(e);
  const li = document.createElement('li');
  if (e.art === 'ergebnis') {
    const belege = (e.belege || []).map((b) => `<li>${esc(b.filename)}</li>`).join('');
    li.className = 'ergebnis';
    li.innerHTML = `
      <strong>Ergebnis (${esc(e.status)})</strong> — Ticket ${esc(e.ticket)}, ${e.schritte ?? 0} Schritte<br>
      ${esc(e.hinweis || '')}
      ${belege ? `<ul style="margin:6px 0 0">${belege}</ul>` : '<div class="leise">Keine Belege abgelegt.</div>'}`;
  } else {
    li.className = `art${String(e.art).replace(/[^a-zä]/gi, '')}`;
    li.innerHTML = `<span class="symbol">${SCHRITT_SYMBOL[e.art] || '·'}</span>
      <span><span class="leise">${esc(e.art)}</span> ${esc(e.text || '')}</span>`;
  }
  liste.append(li);
}

async function ladeDateienHoch(taskId, dateien) {
  for (const datei of dateien) {
    try {
      await api(`/api/tasks/${taskId}/dateien`, {
        method: 'POST',
        headers: {
          'Content-Type': datei.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(datei.name),
        },
        body: datei,
      });
    } catch (err) { fehlerBehandeln(err); }
  }
  melde(`${dateien.length} Datei(en) hochgeladen.`, 'erfolg');
  await ladeAufgaben();
}

// --- Bankabgleich -----------------------------------------------------------

async function ladeBankgruppen() {
  try {
    const daten = await holen(`/api/periods/${zustand.periodeId}/bank/gruppen`);
    zustand.gruppen = daten.gruppen;
    zeichneBankgruppen(daten);
  } catch (err) { fehlerBehandeln(err); }
}

function zeichneBankgruppen(daten) {
  const ziel = $('#bank-gruppen');
  if (!daten.gruppen.length) {
    ziel.innerHTML = '<div class="leer">Noch kein Kontoauszug für diesen Zeitraum importiert.</div>';
    return;
  }
  ziel.innerHTML = daten.gruppen.map((g) => `
    <details class="gruppe">
      <summary>
        <span class="name">${esc(g.label)}</span>
        <span class="klein-text leise zahl">${g.anzahl} Buchung(en)</span>
        <span class="zahl" style="width:110px;text-align:right">${euro(g.summe_cents)}</span>
        <span class="klein-text leise zahl" style="width:150px;text-align:right">
          Belege: ${g.belege_anzahl} / ${euro(g.belege_summe_cents)}</span>
        <span class="zahl ${g.vollstaendig ? 'diff-ok' : 'diff-offen'}" style="width:110px;text-align:right">
          ${g.vollstaendig ? '✓ ' : 'Δ '}${euro(g.differenz_cents)}</span>
      </summary>
      <table style="background:var(--flaeche-2)">
        <thead><tr><th>Datum</th><th>Empfänger / Zweck</th><th class="rechts">Betrag</th><th style="width:110px">Kürzel</th><th>Notiz</th></tr></thead>
        <tbody>
          ${g.buchungen.map((b) => `
            <tr>
              <td class="zahl klein-text">${datumDe(b.booking_date)}</td>
              <td class="klein-text"><strong>${esc(b.counterparty || '—')}</strong><br><span class="leise">${esc(b.purpose)}</span></td>
              <td class="rechts zahl">${euro(b.amount_cents)}</td>
              <td><input type="text" class="tx-tag klein-text" data-id="${b.id}" value="${esc(b.tag)}" placeholder="Kürzel"></td>
              <td><input type="text" class="tx-note klein-text" data-id="${b.id}" value="${esc(b.note)}"></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </details>`).join('') +
    `<div class="inhalt klein-text leise">${daten.buchungen_gesamt} Buchungen insgesamt.
     ${daten.belege_ohne_zuordnung.length} Beleg(e) ohne Zuordnung — trage bei der Datei eine Zuordnung ein, damit sie hier gegengerechnet wird.</div>`;

  $$('.tx-tag').forEach((el) => {
    el.onchange = async () => {
      const kuerzel = el.value.trim();
      if (kuerzel && !confirm(`Beleganfrage per Mail an "${kuerzel}" senden?`)) { el.value = ''; return; }
      try {
        const r = await senden(`/api/bank/buchungen/${el.dataset.id}`, { tag: kuerzel }, 'PATCH');
        if (r.anfrage) {
          melde(`Anfrage ${r.anfrage.ticket} an ${r.anfrage.recipient} — Status: ${r.anfrage.status}`, 'erfolg');
          await ladeLogbuch();
        }
      } catch (err) { fehlerBehandeln(err); }
    };
  });
  $$('.tx-note').forEach((el) => {
    el.onchange = () => senden(`/api/bank/buchungen/${el.dataset.id}`, { note: el.value }, 'PATCH').catch(fehlerBehandeln);
  });
}

// --- Logbuch ----------------------------------------------------------------

async function ladeLogbuch() {
  try {
    const eintraege = await holen(`/api/periods/${zustand.periodeId}/logbuch`);
    $('#logbuch-inhalt').innerHTML = eintraege.length ? `
      <table>
        <thead><tr><th>Ticket</th><th>Vorgang</th><th>Empfänger</th><th>Status</th><th>Verlauf</th><th></th></tr></thead>
        <tbody>${eintraege.map((e) => `
          <tr>
            <td class="klein-text zahl"><strong>${esc(e.ticket)}</strong><br><span class="leise">${esc(e.created_at)}</span></td>
            <td class="klein-text">${esc(e.subject || e.type)}
              ${e.counterparty ? `<br><span class="leise">${esc(e.counterparty)} · ${euro(e.amount_cents)} · ${datumDe(e.booking_date)}</span>` : ''}
              ${e.task_title ? `<br><span class="leise">Aufgabe: ${esc(e.task_title)}</span>` : ''}</td>
            <td class="klein-text">${esc(e.recipient || '—')}</td>
            <td><span class="badge ${e.status}">${esc(e.status)}</span>
              ${e.resolution ? `<br><span class="klein-text leise">${esc(e.resolution)}</span>` : ''}</td>
            <td><ul class="verlauf">${e.verlauf.map((v) => `<li>${esc(v.at)} — ${esc(v.event)}${v.detail ? ': ' + esc(v.detail.slice(0, 90)) : ''}</li>`).join('')}</ul></td>
            <td>${['offen', 'gesendet'].includes(e.status)
              ? `<button class="knopf leise klein lb-pruefen" data-id="${e.id}">Prüfen</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="leer">Noch keine Einträge.</div>';

    $$('.lb-pruefen').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await senden(`/api/logbuch/${b.dataset.id}/pruefen`, {});
          melde(`${r.ticket}: ${r.status}${r.resolution ? ' — ' + r.resolution : ''}`, r.status === 'erledigt' ? 'erfolg' : 'info');
          await ladeLogbuch();
        } catch (err) { fehlerBehandeln(err); }
      };
    });
  } catch (err) { fehlerBehandeln(err); }
}

// --- Kürzel -----------------------------------------------------------------

async function ladeKuerzel() {
  try {
    const liste = await holen('/api/kuerzel');
    $('#kuerzel-liste').innerHTML = liste.map((k) => `
      <tr><td><strong>${esc(k.code)}</strong></td><td>${esc(k.email)}</td><td>${esc(k.name)}</td>
      <td class="rechts"><button class="knopf gefahr klein k-loeschen" data-id="${k.id}">×</button></td></tr>`).join('')
      || '<tr><td colspan="4" class="leise klein-text">Noch keine Kürzel hinterlegt — unbekannte werden automatisch aufgelöst.</td></tr>';
    $$('.k-loeschen').forEach((b) => {
      b.onclick = () => api(`/api/kuerzel/${b.dataset.id}`, { method: 'DELETE' }).then(ladeKuerzel).catch(fehlerBehandeln);
    });
  } catch (err) { fehlerBehandeln(err); }
}

// --- Belegerstellung --------------------------------------------------------

function alleDateien() {
  return zustand.aufgaben.flatMap((a) => a.dateien.map((d) => ({ ...d, aufgabe: a.title })));
}

function fuelleBelegAuswahl() {
  const dateien = alleDateien();
  const optionen = dateien.map((d) => `<option value="${d.id}">${esc(d.filename)} — ${esc(d.aufgabe)}</option>`).join('');
  $('#bew-quittung').innerHTML = '<option value="">Quittung wählen …</option>' + optionen;
  $('#sp-anlagen').innerHTML = optionen;
  const aufgaben = '<option value="">Keine Zuordnung</option>' +
    zustand.aufgaben.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join('');
  $('#bew-aufgabe').innerHTML = aufgaben;
  $('#sp-aufgabe').innerHTML = aufgaben;
}

$('#bew-auslesen').onclick = async (e) => {
  const id = $('#bew-quittung').value;
  if (!id) return melde('Bitte zuerst eine Quittung auswählen.', 'fehler');
  e.target.disabled = true; e.target.textContent = 'Liest …';
  try {
    const d = await senden(`/api/dateien/${id}/analyse`, { art: 'bewirtung' });
    if (d.haendler) $('#bew-restaurant').value = d.haendler;
    if (d.strasse) $('#bew-strasse').value = d.strasse;
    if (d.plz) $('#bew-plz').value = d.plz;
    if (d.ort) $('#bew-ort').value = d.ort;
    if (d.datum) $('#bew-datum').value = d.datum;
    if (d.brutto_cents) $('#bew-brutto').value = (d.brutto_cents / 100).toFixed(2);
    if (d.trinkgeld_cents) $('#bew-trinkgeld').value = (d.trinkgeld_cents / 100).toFixed(2);
    if (d.ust_cents) $('#bew-ust').value = (d.ust_cents / 100).toFixed(2);
    if (d.zahlungsart) $('#bew-zahlungsart').value = d.zahlungsart;
    $('#bew-offene-punkte').innerHTML = (d.offene_punkte || []).length
      ? `<div class="karte" style="background:var(--gelb-weich);border:0;margin-bottom:14px"><div class="inhalt">
           <strong class="klein-text">Bitte noch angeben:</strong>
           <ul class="klein-text" style="margin:6px 0 0">${d.offene_punkte.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
           ${d.hinweis ? `<p class="klein-text" style="margin:8px 0 0">${esc(d.hinweis)}</p>` : ''}
         </div></div>`
      : '';
    melde(d.ki ? 'Quittung ausgelesen.' : 'Mock-Modus — bitte manuell ausfüllen.', d.ki ? 'erfolg' : 'info');
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false; e.target.textContent = 'Quittung mit KI auslesen';
};

$('#bew-erstellen').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const anlage = $('#bew-quittung').value;
    const r = await senden(`/api/periods/${zustand.periodeId}/belege/bewirtung`, {
      datum: $('#bew-datum').value,
      restaurant: $('#bew-restaurant').value.trim(),
      strasse: $('#bew-strasse').value.trim(),
      plz: $('#bew-plz').value.trim(),
      ort: $('#bew-ort').value.trim(),
      bewirtender: $('#bew-bewirtender').value.trim(),
      anlass: $('#bew-anlass').value.trim(),
      teilnehmer: $('#bew-teilnehmer').value.split('\n').filter((t) => t.trim()),
      brutto_cents: zuCents($('#bew-brutto').value),
      trinkgeld_cents: zuCents($('#bew-trinkgeld').value || 0),
      ust_cents: zuCents($('#bew-ust').value || 0),
      zahlungsart: $('#bew-zahlungsart').value.trim(),
      task_id: $('#bew-aufgabe').value || null,
      anlagen: anlage ? [anlage] : [],
    });
    melde(`Beleg erstellt: ${r.datei.filename} — davon ${euro(r.zusammenfassung.abziehbar_cents)} abziehbar.`, 'erfolg');
    await ladeAufgaben();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false;
};

// Spesen: Positionen und Verpflegungstage
function positionZeile() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="date" class="p-datum"></td>
    <td><input type="text" class="p-art" placeholder="Hotel"></td>
    <td><input type="text" class="p-text" placeholder="Booking.com, 2 Nächte"></td>
    <td><input type="number" step="0.01" class="p-betrag rechts"></td>
    <td><button class="knopf gefahr klein">×</button></td>`;
  tr.querySelector('button').onclick = () => tr.remove();
  return tr;
}
function tagZeile() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="date" class="t-datum"></td>
    <td><select class="t-art"><option value="teil">An-/Abreise oder über 8 Std.</option><option value="voll">Voller Tag (24 Std.)</option></select></td>
    <td><input type="checkbox" class="t-f" style="width:auto"></td>
    <td><input type="checkbox" class="t-m" style="width:auto"></td>
    <td><input type="checkbox" class="t-a" style="width:auto"></td>
    <td><button class="knopf gefahr klein">×</button></td>`;
  tr.querySelector('button').onclick = () => tr.remove();
  return tr;
}
$('#sp-position-hinzufuegen').onclick = () => $('#sp-positionen').append(positionZeile());
$('#sp-tag-hinzufuegen').onclick = () => $('#sp-tage').append(tagZeile());

$('#sp-erstellen').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const positionen = $$('#sp-positionen tr').map((tr) => ({
      datum: tr.querySelector('.p-datum').value,
      art: tr.querySelector('.p-art').value.trim(),
      beschreibung: tr.querySelector('.p-text').value.trim(),
      betrag_cents: zuCents(tr.querySelector('.p-betrag').value),
    })).filter((p) => p.betrag_cents);
    const tage = $$('#sp-tage tr').map((tr) => ({
      datum: tr.querySelector('.t-datum').value,
      art: tr.querySelector('.t-art').value,
      fruehstueck: tr.querySelector('.t-f').checked,
      mittagessen: tr.querySelector('.t-m').checked,
      abendessen: tr.querySelector('.t-a').checked,
    })).filter((t) => t.datum);

    const r = await senden(`/api/periods/${zustand.periodeId}/belege/spesen`, {
      reisender: $('#sp-reisender').value.trim(),
      reiseziel: $('#sp-ziel').value.trim(),
      reisegrund: $('#sp-grund').value.trim(),
      beginn_datum: $('#sp-beginn').value,
      ende_datum: $('#sp-ende').value,
      firmenkarte: $('#sp-firmenkarte').checked,
      positionen,
      verpflegung: { tage },
      task_id: $('#sp-aufgabe').value || null,
      anlagen: [...$('#sp-anlagen').selectedOptions].map((o) => o.value),
    });
    melde(`Spesenabrechnung erstellt: ${r.datei.filename} — ${euro(r.zusammenfassung.gesamt_cents)}.`, 'erfolg');
    await ladeAufgaben();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false;
};

// --- Globale Bedienelemente -------------------------------------------------

$$('nav button').forEach((b) => {
  b.onclick = () => {
    $$('nav button').forEach((x) => x.classList.remove('aktiv'));
    $$('.reiter').forEach((x) => x.classList.remove('aktiv'));
    b.classList.add('aktiv');
    $(`#reiter-${b.dataset.reiter}`).classList.add('aktiv');
  };
});

$('#periodenwahl').onchange = async (e) => {
  zustand.periodeId = Number(e.target.value);
  zustand.aufgabeId = null;
  await ladeAlles();
};

$('#neuer-zeitraum').onclick = async () => {
  const jetzt = new Date();
  const eingabe = prompt('Zeitraum anlegen (Format JJJJ-MM):',
    `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`);
  if (!eingabe) return;
  const m = eingabe.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return melde('Bitte im Format JJJJ-MM angeben.', 'fehler');
  try {
    const p = await senden('/api/periods', { year: Number(m[1]), month: Number(m[2]) });
    zustand.periodeId = p.id;
    await ladePerioden();
    melde(`Zeitraum ${p.label} ${p.year} angelegt.`, 'erfolg');
  } catch (err) { fehlerBehandeln(err); }
};

$('#aufgabe-hinzufuegen').onclick = async () => {
  const titel = prompt('Titel der neuen Aufgabe:');
  if (!titel?.trim()) return;
  try {
    const t = await senden(`/api/periods/${zustand.periodeId}/tasks`, { title: titel.trim() });
    zustand.aufgabeId = t.id;
    await ladeAufgaben();
  } catch (err) { fehlerBehandeln(err); }
};

$('#als-vorlage').onclick = async () => {
  if (!confirm('Die aktuelle Aufgabenliste als Vorlage für neue Zeiträume sichern? Die bisherige Vorlage wird ersetzt.')) return;
  try {
    const r = await senden(`/api/periods/${zustand.periodeId}/als-vorlage`, {});
    melde(`${r.vorlagen} Aufgaben als Vorlage gesichert.`, 'erfolg');
  } catch (err) { fehlerBehandeln(err); }
};

$('#ki-generieren').onclick = async (e) => {
  const prompt = $('#ki-prompt').value.trim();
  if (!prompt) return melde('Bitte eine Anweisung eingeben.', 'fehler');
  e.target.disabled = true; e.target.textContent = 'Erzeugt …';
  try {
    const r = await senden(`/api/periods/${zustand.periodeId}/ki/aufgaben`, { prompt, modus: $('#ki-modus').value });
    melde(`${r.angelegt} Aufgabe(n) angelegt, ${r.unveraendert} erledigte behalten.${r.ki ? '' : ' (Mock-Modus)'}`, 'erfolg');
    await ladeAufgaben();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false; e.target.textContent = 'Liste erzeugen';
};

$('#logbuch-pruefen').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await senden(`/api/periods/${zustand.periodeId}/logbuch/pruefen`, {});
    melde(`${r.length} Eintrag/Einträge geprüft.`, 'erfolg');
    await ladeLogbuch();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false;
};

$('#kuerzel-speichern').onclick = async () => {
  try {
    await senden('/api/kuerzel', {
      code: $('#kuerzel-code').value.trim(),
      email: $('#kuerzel-email').value.trim(),
      name: $('#kuerzel-name').value.trim(),
    });
    $('#kuerzel-code').value = ''; $('#kuerzel-email').value = ''; $('#kuerzel-name').value = '';
    await ladeKuerzel();
    melde('Kürzel gespeichert.', 'erfolg');
  } catch (err) { fehlerBehandeln(err); }
};

// Bankauszug hochladen
const bankAblegen = $('#bank-ablegen');
const bankEingabe = $('#bank-datei');
bankAblegen.onclick = () => bankEingabe.click();
bankAblegen.ondragover = (e) => { e.preventDefault(); bankAblegen.classList.add('aktiv'); };
bankAblegen.ondragleave = () => bankAblegen.classList.remove('aktiv');
bankAblegen.ondrop = (e) => { e.preventDefault(); bankAblegen.classList.remove('aktiv'); importiereBank(e.dataTransfer.files[0]); };
bankEingabe.onchange = () => importiereBank(bankEingabe.files[0]);

async function importiereBank(datei) {
  if (!datei) return;
  try {
    const r = await api(`/api/periods/${zustand.periodeId}/bank/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', 'X-Filename': encodeURIComponent(datei.name) },
      body: datei,
    });
    melde(`${r.buchungen} Buchungen importiert${r.verworfen ? `, ${r.verworfen} Zeile(n) übersprungen` : ''}.`, 'erfolg');
    await ladeBankgruppen();
  } catch (err) { fehlerBehandeln(err); }
}

start();
