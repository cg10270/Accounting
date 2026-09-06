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
  monat: null,
  lieferanten: [],
  offen: new Set(),      // aufgeklappte Bereiche (b<id>) und Positionen (p<id>)
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
  $('#pf-postfach').textContent = s.buchhaltungspostfach;
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
    .map((p) => `<option value="${p.id}">${esc(p.label)} ${p.year} — ${p.lieferanten_erledigt}/${p.lieferanten} Lieferanten erledigt</option>`)
    .join('');
  if (!zustand.perioden.some((p) => p.id === zustand.periodeId)) zustand.periodeId = zustand.perioden[0].id;
  wahl.value = zustand.periodeId;
  await ladeAlles();
}

async function ladeAlles() {
  await Promise.all([ladeMonat(), ladeLieferanten(), ladeAufgaben(), ladeLogbuch(), ladeKuerzel()]);
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
      <label class="feld"><span>Notizen</span><textarea id="d-notizen" style="min-height:50px">${esc(a.notes)}</textarea></label>
      <div class="reihe" style="margin-bottom:22px">
        <button class="knopf" id="d-speichern">Speichern</button>
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

    </div>`;

  verdrahteAufgabendetail(a);

}

function verdrahteAufgabendetail(a) {
  const patch = (daten) => senden(`/api/tasks/${a.id}`, daten, 'PATCH').then(ladeAufgaben).catch(fehlerBehandeln);

  $('#d-erledigt').onchange = (e) => patch({ status: e.target.checked ? 'erledigt' : 'offen' });
  $('#d-status').onchange = (e) => patch({ status: e.target.value });
  $('#d-speichern').onclick = () => patch({
    title: $('#d-titel').value.trim(),
    description: $('#d-beschreibung').value,
    notes: $('#d-notizen').value,
  });
  $('#d-loeschen').onclick = async () => {
    if (!confirm(`Aufgabe "${a.title}" wirklich löschen?`)) return;
    try { await api(`/api/tasks/${a.id}`, { method: 'DELETE' }); zustand.aufgabeId = null; await ladeAufgaben(); }
    catch (err) { fehlerBehandeln(err); }
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
      try { await api(`/api/dateien/${b.dataset.id}`, { method: 'DELETE' }); await ladeAufgaben(); await Promise.all([ladeMonat(), ladeLieferanten()]); }
      catch (err) { fehlerBehandeln(err); }
    };
  });
  const dateiPatch = (el, feld, wert) =>
    senden(`/api/dateien/${el.dataset.id}`, { [feld]: wert }, 'PATCH')
      .then(() => { ladeAufgaben(); ladeMonat(); })
      .catch(fehlerBehandeln);
  $$('.d-vendor').forEach((el) => { el.onchange = () => dateiPatch(el, 'vendor', el.value.trim()); });
  $$('.d-betrag').forEach((el) => { el.onchange = () => dateiPatch(el, 'amount_cents', el.value === '' ? null : zuCents(el.value)); });


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

// --- Checkliste: Bereiche, Lieferanten, Positionen ---------------------------

async function ladeMonat() {
  try {
    zustand.monat = await holen(`/api/periods/${zustand.periodeId}/checkliste`);
    zeichneMonat();
  } catch (err) { fehlerBehandeln(err); }
}

function zeichneMonat() {
  const d = zustand.monat;
  if (!d) return;
  const s = d.summen;

  $('#monat-summen').textContent =
    `${s.erledigt}/${s.positionen} erledigt · Bank ${euro(s.bank_summe_cents)} · ` +
    `Belege ${euro(s.belege_summe_cents)} · offene Differenz ${euro(s.offene_differenz_cents)}`;

  $('#monat-tabelle').innerHTML = d.bereiche.length
    ? d.bereiche.map(zeichneBereich).join('')
    : '<div class="leer">Noch keine Checkliste angelegt — <code>npm run seed:checkliste</code> ausführen.</div>';

  const ohne = $('#karte-ohne-zuordnung');
  ohne.hidden = !d.ohne_zuordnung.length;
  if (d.ohne_zuordnung.length) zeichneOhneZuordnung(d.ohne_zuordnung);
  verdrahteMonat();
}

function zeichneBereich(b) {
  const zu = zustand.offen.has(`b${b.id}`);
  const fertig = b.erledigt === b.anzahl;
  return `
    <div class="bereich">
      <div class="bereich-kopf" data-b="${b.id}">
        <span class="pfeil">${zu ? '▸' : '▾'}</span>
        <span class="nummer">${b.nummer}</span>
        <span class="titel">${esc(b.name)}</span>
        <span class="klein-text ${fertig ? 'diff-ok' : 'leise'}">${b.erledigt}/${b.anzahl}</span>
      </div>
      ${zu ? '' : `<div class="bereich-inhalt">${b.gruppen.map(zeichneGruppe).join('')}</div>`}
    </div>`;
}

// Trägt ein Lieferant nur eine Position gleichen Namens, wäre eine eigene
// Kopfzeile bloß eine Wiederholung - dann steht das Häkchen in der Kopfzeile.
function nurEineZeile(g) {
  if (!g.lieferant || g.positionen.length !== 1) return false;
  const a = g.lieferant.name.toLowerCase();
  const b = g.positionen[0].name.toLowerCase();
  return a === b || b.includes(a) || a.includes(b);
}

function zeichneGruppe(g) {
  const l = g.lieferant;
  const kompakt = nurEineZeile(g);
  const p = g.positionen[0];

  // Ohne Lieferanten gibt es nichts abzugleichen - dann stehen die
  // Positionen ohne Kopfzeile für sich.
  const kopf = !l ? '' : `
    <div class="gruppe-kopf ${kompakt ? 'kompakt' : ''}">
      ${kompakt ? `<input type="checkbox" class="pos-haken" data-id="${p.id}" ${p.status === 'erledigt' ? 'checked' : ''}>` : ''}
      <span class="name ${kompakt ? 'pos-name' : ''}" ${kompakt ? `data-id="${p.id}"` : ''}>${esc(kompakt ? p.name : l.name)}
        ${l.has_mfa ? '<span class="badge wartet" style="margin-left:6px">Code</span>' : ''}
        ${kompakt && p.hinweis ? `<br><span class="klein-text leise">${esc(p.hinweis)}</span>` : ''}</span>
      <span class="zahl klein-text">${g.bank_anzahl ? `Bank ${g.bank_anzahl} · ${euro(g.bank_summe_cents)}` : '<span class="leise">keine Buchung</span>'}</span>
      <span class="zahl klein-text">${g.belege_anzahl ? `Belege ${g.belege_anzahl} · ${euro(g.belege_summe_cents)}` : '<span class="leise">keine Belege</span>'}</span>
      <span class="zahl ${g.stimmt ? 'diff-ok' : g.ruhig ? 'leise' : 'diff-offen'}">
        ${g.ruhig ? '—' : (g.stimmt ? '✓ ' : 'Δ ') + euro(g.differenz_cents)}</span>
      <button class="knopf klein lf-portal" data-id="${l.id}" ${l.url ? '' : 'disabled title="Keine Portaladresse hinterlegt"'}>Portal</button>
    </div>`;
  const zeilen = kompakt
    ? (zustand.offen.has(`p${p.id}`) ? `<div class="position eingerueckt">${detailBlock(p)}</div>` : '')
    : g.positionen.map((pos) => zeichnePosition(pos, Boolean(l))).join('');
  return `<div class="gruppe ${kompakt ? 'ist-kompakt' : ''}">${kopf}${zeilen}</div>`;
}

function zeichnePosition(p, hatLieferant) {
  const offen = zustand.offen.has(`p${p.id}`);
  return `
    <div class="position ${p.status !== 'offen' ? 'ist-erledigt' : ''} ${hatLieferant ? 'eingerueckt' : ''}">
      <input type="checkbox" class="pos-haken" data-id="${p.id}" ${p.status === 'erledigt' ? 'checked' : ''}>
      <span class="pos-name" data-id="${p.id}">
        ${esc(p.name)}${p.status === 'entfaellt' ? ' <span class="badge offen">entfällt</span>' : ''}
        ${p.hinweis ? `<br><span class="klein-text leise">${esc(p.hinweis)}</span>` : ''}
        ${p.notiz ? `<br><span class="klein-text">${esc(p.notiz)}</span>` : ''}
      </span>
      <span class="klein-text leise pos-dateien" data-id="${p.id}">
        ${p.dateien.length ? `${p.dateien.length} Datei(en)` : ''}
      </span>
      ${offen ? detailBlock(p) : ''}
    </div>`;
}

function detailBlock(p) {
  return `
    <div class="pos-detail">
      ${p.dateien.map((f) => `
        <div class="reihe klein-text" style="padding:3px 0">
          <a href="/api/dateien/${f.id}/inhalt" target="_blank" style="flex:1">${esc(f.filename)}</a>
          <input type="number" step="0.01" class="pos-betrag" data-id="${f.id}"
                 value="${f.amount_cents ? (f.amount_cents / 100).toFixed(2) : ''}" placeholder="Betrag" style="width:100px">
          <button class="knopf gefahr klein pos-datei-weg" data-id="${f.id}">×</button>
        </div>`).join('')}
      <div class="ablegen pos-ablegen" data-id="${p.id}" style="padding:10px;margin-top:6px">
        Beleg hierher ziehen oder klicken
        <input type="file" class="pos-datei" data-id="${p.id}" multiple hidden>
      </div>
      <div class="reihe" style="margin-top:8px">
        <input type="text" class="pos-notiz" data-id="${p.id}" value="${esc(p.notiz)}" placeholder="Notiz" style="flex:1">
        <button class="knopf leise klein pos-entfaellt" data-id="${p.id}">Entfällt diesen Monat</button>
      </div>
    </div>`;
}

function zeichneOhneZuordnung(buchungen) {
  const lieferanten = zustand.lieferanten.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('#ohne-zuordnung').innerHTML = `
    <table><thead><tr><th>Datum</th><th>Empfänger / Zweck</th><th class="rechts">Betrag</th><th style="width:280px"></th></tr></thead>
    <tbody>${buchungen.map((b) => `
      <tr>
        <td class="zahl klein-text">${datumDe(b.booking_date)}</td>
        <td class="klein-text"><strong>${esc(b.counterparty || '—')}</strong><br><span class="leise">${esc(b.purpose)}</span></td>
        <td class="rechts zahl">${euro(b.amount_cents)}</td>
        <td class="reihe" style="justify-content:flex-end">
          <select class="zu-lieferant klein-text" data-tx="${b.id}" style="width:150px">
            <option value="">neu anlegen …</option>${lieferanten}
          </select>
          <button class="knopf leise klein tx-zuordnen" data-tx="${b.id}">Zuordnen</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
}

function verdrahteMonat() {
  const neuLaden = () => Promise.all([ladeMonat(), ladeLieferanten()]);
  const umschalten = (schluessel) => {
    zustand.offen.has(schluessel) ? zustand.offen.delete(schluessel) : zustand.offen.add(schluessel);
    zeichneMonat();
  };

  $$('.bereich-kopf').forEach((el) => { el.onclick = () => umschalten(`b${el.dataset.b}`); });
  $$('.pos-name, .pos-dateien').forEach((el) => { el.onclick = () => umschalten(`p${el.dataset.id}`); });

  const status = (id, daten) =>
    senden(`/api/periods/${zustand.periodeId}/positionen/${id}/status`, daten).then(neuLaden).catch(fehlerBehandeln);

  $$('.pos-haken').forEach((el) => {
    el.onchange = () => status(el.dataset.id, { status: el.checked ? 'erledigt' : 'offen' });
  });
  $$('.pos-entfaellt').forEach((el) => { el.onclick = () => status(el.dataset.id, { status: 'entfaellt' }); });
  $$('.pos-notiz').forEach((el) => {
    el.onchange = () => status(el.dataset.id, { status: 'offen', notiz: el.value });
  });

  $$('.lf-portal').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); portalOeffnen(el, Number(el.dataset.id)); }; });

  $$('.pos-betrag').forEach((el) => {
    el.onchange = () => senden(`/api/dateien/${el.dataset.id}`,
      { amount_cents: el.value === '' ? null : zuCents(el.value) }, 'PATCH').then(neuLaden).catch(fehlerBehandeln);
  });
  $$('.pos-datei-weg').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Beleg wirklich löschen?')) return;
      try { await api(`/api/dateien/${el.dataset.id}`, { method: 'DELETE' }); await neuLaden(); }
      catch (err) { fehlerBehandeln(err); }
    };
  });

  $$('.pos-ablegen').forEach((zone) => {
    const eingabe = zone.querySelector('.pos-datei');
    zone.onclick = () => eingabe.click();
    eingabe.onchange = () => belegeHochladen(Number(zone.dataset.id), [...eingabe.files]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('aktiv'); };
    zone.ondragleave = () => zone.classList.remove('aktiv');
    zone.ondrop = (e) => {
      e.preventDefault(); zone.classList.remove('aktiv');
      belegeHochladen(Number(zone.dataset.id), [...e.dataTransfer.files]);
    };
  });

  $$('.tx-zuordnen').forEach((el) => {
    el.onclick = async () => {
      const wahl = $(`.zu-lieferant[data-tx="${el.dataset.tx}"]`).value;
      try {
        const r = await senden(`/api/bank/buchungen/${el.dataset.tx}/lieferant`,
          wahl ? { lieferant_id: Number(wahl) } : {});
        melde(`Zugeordnet: ${r.lieferant.name}`, 'erfolg');
        await neuLaden();
      } catch (err) { fehlerBehandeln(err); }
    };
  });
}

async function belegeHochladen(positionId, dateien) {
  for (const datei of dateien) {
    try {
      await api(`/api/periods/${zustand.periodeId}/positionen/${positionId}/dateien`, {
        method: 'POST',
        headers: { 'Content-Type': datei.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(datei.name) },
        body: datei,
      });
    } catch (err) { fehlerBehandeln(err); }
  }
  melde(`${dateien.length} Beleg(e) hochgeladen.`, 'erfolg');
  await Promise.all([ladeMonat(), ladeLieferanten()]);
}

async function portalOeffnen(knopf, lieferantId) {
  knopf.disabled = true;
  const alt = knopf.textContent;
  knopf.textContent = '…';
  try {
    const r = await senden(`/api/periods/${zustand.periodeId}/lieferanten/${lieferantId}/portal`, {});
    const art = { ok: 'erfolg', bereits: 'erfolg', mfa: 'info', keine: 'info', fehler: 'fehler' }[r.anmeldung?.art] || 'info';
    melde(`${r.lieferant}: ${r.anmeldung?.text || 'Fenster geöffnet.'}\n` +
          'Lade die Belege im Fenster herunter — sie werden automatisch übernommen.', art);
    beobachtePortal(lieferantId);
  } catch (err) { fehlerBehandeln(err); }
  knopf.disabled = false;
  knopf.textContent = alt;
}

// Solange das Fenster offen ist, den Stand der übernommenen Belege verfolgen.
function beobachtePortal(lieferantId) {
  let zuletzt = 0;
  const takt = setInterval(async () => {
    let z;
    try { z = await holen(`/api/lieferanten/${lieferantId}/portal`); }
    catch { clearInterval(takt); return; }
    if (!z.offen) { clearInterval(takt); await ladeMonat(); return; }
    if (z.uebernommen.length > zuletzt) {
      zuletzt = z.uebernommen.length;
      melde(`Übernommen: ${z.uebernommen[zuletzt - 1].filename}`, 'erfolg');
      await ladeMonat();
    }
  }, 2500);
}

// --- Postfach ----------------------------------------------------------------

let pfTreffer = null;

$('#pf-suchen').onclick = async (e) => {
  e.target.disabled = true;
  const alt = e.target.textContent;
  e.target.textContent = 'Sucht …';
  try {
    pfTreffer = await senden(`/api/periods/${zustand.periodeId}/postfach/suche`,
      { nachlaufTage: Number($('#pf-nachlauf').value) || 0 });
    zeichnePostfach();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false;
  e.target.textContent = alt;
};

function zeichnePostfach() {
  const d = pfTreffer;
  $('#pf-zeitraum').textContent = `${datumDe(d.zeitraum.von)} bis ${datumDe(d.zeitraum.bis)}`;
  $('#pf-karte').hidden = false;

  // Ohne echtes Postfach ist ein leeres Ergebnis keine Aussage über Rechnungen.
  $('#pf-warnung').hidden = d.zugang?.echtesPostfach !== false;
  if (d.zugang?.echtesPostfach === false) $('#pf-warnung-text').textContent = d.zugang.hinweis;

  $('#pf-stand').textContent =
    `${d.nachrichten} Mail(s) durchsucht · ${d.kandidaten.length} Anhänge · ` +
    `${d.neu} neu${d.verworfen ? ` · ${d.verworfen} aussortiert` : ''}`;

  if (!d.kandidaten.length) {
    $('#pf-treffer').innerHTML = '<div class="leer">Keine Belege im Zeitraum gefunden.</div>';
    return;
  }

  $('#pf-treffer').innerHTML = `
    <table>
      <thead><tr>
        <th style="width:30px"></th><th>Anhang</th><th>Absender / Betreff</th>
        <th style="width:150px">Lieferant</th><th style="width:100px" class="rechts">Betrag €</th>
      </tr></thead>
      <tbody>${d.kandidaten.map((k, i) => `
        <tr class="${k.schon_uebernommen ? 'ist-erledigt' : ''}">
          <td><input type="checkbox" class="pf-wahl" data-i="${i}" ${k.schon_uebernommen ? 'disabled' : ''} style="width:auto"></td>
          <td class="klein-text">
            <strong>${esc(k.filename)}</strong><br>
            <span class="leise">${Math.round(k.size / 1024)} kB${k.schon_uebernommen ? ' · bereits übernommen' : ''}</span>
          </td>
          <td class="klein-text">${esc(k.absender)}<br><span class="leise">${esc(k.betreff)}</span></td>
          <td>
            <select class="pf-lieferant klein-text" data-i="${i}">
              <option value="">— ohne —</option>
              ${zustand.lieferanten.map((l) =>
                `<option value="${l.id}" ${k.lieferant?.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
            </select>
          </td>
          <td><input type="number" step="0.01" class="pf-betrag klein-text rechts" data-i="${i}" placeholder="—"></td>
        </tr>`).join('')}</tbody>
    </table>`;
}

$('#pf-alle').onclick = () => {
  $$('.pf-wahl').forEach((el) => { if (!el.disabled) el.checked = true; });
};

$('#pf-uebernehmen').onclick = async (e) => {
  const auswahl = $$('.pf-wahl').filter((el) => el.checked).map((el) => {
    const i = Number(el.dataset.i);
    const k = pfTreffer.kandidaten[i];
    const betrag = $(`.pf-betrag[data-i="${i}"]`).value;
    const lieferant = $(`.pf-lieferant[data-i="${i}"]`).value;
    return {
      message_id: k.message_id, attachment_id: k.attachment_id,
      filename: k.filename, mime: k.mime,
      absender: k.absender, betreff: k.betreff,
      lieferant_id: lieferant ? Number(lieferant) : null,
      betrag_cents: betrag === '' ? null : zuCents(betrag),
    };
  });
  if (!auswahl.length) return melde('Nichts ausgewählt.', 'fehler');

  e.target.disabled = true;
  try {
    const r = await senden(`/api/periods/${zustand.periodeId}/postfach/uebernehmen`, { auswahl });
    const teile = [`${r.uebernommen.length} übernommen`];
    if (r.uebersprungen.length) teile.push(`${r.uebersprungen.length} übersprungen`);
    if (r.fehler.length) teile.push(`${r.fehler.length} fehlgeschlagen`);
    melde(teile.join(', ') + '.', r.fehler.length ? 'fehler' : 'erfolg');
    if (r.fehler.length) console.warn('Postfach:', r.fehler);
    await Promise.all([ladeMonat(), ladeLieferanten()]);
    // Ergebnis neu holen, damit die Übernommenen als solche markiert sind.
    pfTreffer = await senden(`/api/periods/${zustand.periodeId}/postfach/suche`,
      { nachlaufTage: Number($('#pf-nachlauf').value) || 0 });
    zeichnePostfach();
  } catch (err) { fehlerBehandeln(err); }
  e.target.disabled = false;
};

// --- Lieferanten-Stammdaten --------------------------------------------------

async function ladeLieferanten() {
  try {
    zustand.lieferanten = await holen('/api/lieferanten');
    zeichneLieferanten();
  } catch (err) { fehlerBehandeln(err); }
}

function zeichneLieferanten() {
  $('#lieferantenliste').innerHTML = zustand.lieferanten.length ? `
    <table>
      <thead><tr><th>Name</th><th>Portal</th><th>Zugang</th><th>Muster</th><th></th></tr></thead>
      <tbody>${zustand.lieferanten.map((l) => `
        <tr>
          <td><strong>${esc(l.name)}</strong>${l.erwartet ? `<br><span class="klein-text leise">${l.erwartet} Beleg(e)/Monat</span>` : ''}</td>
          <td class="klein-text">${l.url ? `<a href="${esc(l.url)}" target="_blank">${esc(l.url.slice(0, 46))}</a>` : '<span class="leise">—</span>'}</td>
          <td class="klein-text">${esc(l.username || '—')} ${l.hat_secret ? '· ••••••••' : '<span class="leise">· kein Passwort</span>'}${l.has_mfa ? ' · Code' : ''}</td>
          <td class="klein-text leise">${l.muster.map((m) => esc(m.text)).join(', ') || '—'}</td>
          <td class="rechts reihe" style="justify-content:flex-end">
            <button class="knopf leise klein lf-bearbeiten" data-id="${l.id}">Ändern</button>
            <button class="knopf gefahr klein lf-loeschen" data-id="${l.id}">×</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="leer">Noch keine Lieferanten angelegt.</div>';

  $$('.lf-loeschen').forEach((el) => {
    el.onclick = async () => {
      const l = zustand.lieferanten.find((x) => x.id === Number(el.dataset.id));
      if (!confirm(`Lieferant "${l.name}" wirklich löschen? Belege und Buchungen bleiben erhalten, verlieren aber die Zuordnung.`)) return;
      try { await api(`/api/lieferanten/${el.dataset.id}`, { method: 'DELETE' }); await Promise.all([ladeLieferanten(), ladeMonat()]); }
      catch (err) { fehlerBehandeln(err); }
    };
  });

  $$('.lf-bearbeiten').forEach((el) => {
    el.onclick = () => {
      const l = zustand.lieferanten.find((x) => x.id === Number(el.dataset.id));
      $('#lf-name').value = l.name;
      $('#lf-url').value = l.url;
      $('#lf-rechnungen').value = l.rechnungen_url;
      $('#lf-user').value = l.username;
      $('#lf-secret').value = '';
      $('#lf-secret').placeholder = l.hat_secret ? '••••••••  (leer lassen = unverändert)' : '';
      $('#lf-erwartet').value = l.erwartet;
      $('#lf-muster').value = l.muster.map((m) => m.text).join('\n');
      $('#lf-mfa').checked = Boolean(l.has_mfa);
      $('#lf-anlegen').textContent = `"${l.name}" speichern`;
      $('#lf-anlegen').dataset.id = l.id;
      $('#lf-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });
}

function lieferantFormularLeeren() {
  for (const id of ['lf-name', 'lf-url', 'lf-rechnungen', 'lf-user', 'lf-secret', 'lf-muster']) $(`#${id}`).value = '';
  $('#lf-erwartet').value = 0;
  $('#lf-mfa').checked = false;
  $('#lf-secret').placeholder = '';
  $('#lf-anlegen').textContent = 'Anlegen';
  delete $('#lf-anlegen').dataset.id;
}

$('#lf-anlegen').onclick = async () => {
  const daten = {
    name: $('#lf-name').value.trim(),
    url: $('#lf-url').value.trim(),
    rechnungen_url: $('#lf-rechnungen').value.trim(),
    username: $('#lf-user').value.trim(),
    erwartet: Number($('#lf-erwartet').value) || 0,
    has_mfa: $('#lf-mfa').checked,
    muster: $('#lf-muster').value.split('\n').map((m) => m.trim()).filter(Boolean),
  };
  const secret = $('#lf-secret').value;
  const id = $('#lf-anlegen').dataset.id;
  try {
    // Beim Ändern bedeutet ein leeres Passwortfeld "unverändert lassen".
    if (id) await senden(`/api/lieferanten/${id}`, { ...daten, ...(secret ? { secret } : {}) }, 'PATCH');
    else await senden('/api/lieferanten', { ...daten, secret });
    lieferantFormularLeeren();
    await Promise.all([ladeLieferanten(), ladeMonat()]);
    melde(id ? 'Gespeichert.' : 'Lieferant angelegt.', 'erfolg');
  } catch (err) { fehlerBehandeln(err); }
};

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
    melde(`${r.buchungen} Buchungen importiert, ${r.zuordnung.zugeordnet} zugeordnet${r.zuordnung.ohne ? `, ${r.zuordnung.ohne} ohne Lieferant` : ''}.`, 'erfolg');
    await Promise.all([ladeMonat(), ladeLieferanten()]);
  } catch (err) { fehlerBehandeln(err); }
}

start();
