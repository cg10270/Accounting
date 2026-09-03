// Minimale HTTP-Hilfen - Routing, Body-Parsing, Antworten.

export function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function fehler(res, err, status = 400) {
  const nachricht = err instanceof Error ? err.message : String(err);
  json(res, { fehler: nachricht }, status);
}

export function leseBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const teile = [];
    let laenge = 0;
    req.on('data', (chunk) => {
      laenge += chunk.length;
      if (laenge > maxBytes) {
        reject(new Error(`Die Datei ist groesser als ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        req.destroy();
        return;
      }
      teile.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(teile)));
    req.on('error', reject);
  });
}

export async function leseJson(req) {
  const buffer = await leseBody(req, 8 * 1024 * 1024);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('Ungueltiges JSON im Anfragekoerper.'); }
}

/**
 * Sehr kleiner Router mit Pfadparametern: '/api/tasks/:id/files'
 */
export class Router {
  constructor() { this.routen = []; }
  add(method, muster, handler) {
    const teile = muster.split('/').filter(Boolean);
    this.routen.push({ method, teile, handler });
    return this;
  }
  get(m, h) { return this.add('GET', m, h); }
  post(m, h) { return this.add('POST', m, h); }
  patch(m, h) { return this.add('PATCH', m, h); }
  delete(m, h) { return this.add('DELETE', m, h); }

  finde(method, pfad) {
    const teile = pfad.split('/').filter(Boolean);
    for (const route of this.routen) {
      if (route.method !== method || route.teile.length !== teile.length) continue;
      const params = {};
      let passt = true;
      for (let i = 0; i < route.teile.length; i++) {
        const muster = route.teile[i];
        if (muster.startsWith(':')) params[muster.slice(1)] = decodeURIComponent(teile[i]);
        else if (muster !== teile[i]) { passt = false; break; }
      }
      if (passt) return { handler: route.handler, params };
    }
    return null;
  }
}
