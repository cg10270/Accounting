// Steuerliche Kennzahlen an einer Stelle, damit sie bei Gesetzesaenderungen
// nur hier angepasst werden muessen. Stand: Veranlagungszeitraum 2026.
// Vor dem produktiven Einsatz mit der Steuerkanzlei abstimmen.

export const BEWIRTUNG = {
  // § 4 Abs. 5 Satz 1 Nr. 2 EStG: 70 % der angemessenen Aufwendungen sind
  // Betriebsausgaben, 30 % sind nicht abziehbar. Die Vorsteuer bleibt zu
  // 100 % abziehbar (§ 15 Abs. 1a UStG).
  abziehbar_anteil: 0.7,
  nicht_abziehbar_anteil: 0.3,
  vorsteuer_voll_abziehbar: true,
  // Ab diesem Bruttobetrag muss die Gaststaettenrechnung auf den Namen des
  // bewirtenden Unternehmens lauten (§ 33 UStDV, Kleinbetragsrechnung).
  kleinbetragsgrenze_cents: 25000,
  rechtsgrundlage: '§ 4 Abs. 5 Satz 1 Nr. 2 EStG, R 4.10 EStR',
};

export const REISEKOSTEN = {
  // Verpflegungsmehraufwand Inland (§ 9 Abs. 4a EStG)
  pauschale_voller_tag_cents: 2800,   // Abwesenheit 24 Stunden
  pauschale_teiltag_cents: 1400,      // An-/Abreisetag oder mehr als 8 Stunden
  // Kuerzung bei vom Arbeitgeber gestellten Mahlzeiten, bezogen auf die
  // volle Tagespauschale: Fruehstueck 20 %, Mittag- und Abendessen je 40 %.
  kuerzung_fruehstueck_cents: 560,
  kuerzung_mittagessen_cents: 1120,
  kuerzung_abendessen_cents: 1120,
  rechtsgrundlage: '§ 9 Abs. 4a EStG',
};

export const euro = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export const datumDe = (iso) => {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
};
