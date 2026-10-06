// Requête HTTP avec délai maximal (les sources de prix ne doivent jamais bloquer le jeu).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchWithTimeout };
