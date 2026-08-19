function abs(base, rel) {
  const out = new URL(rel, base);
  const baseUrl = new URL(base);
  for (const [k, v] of baseUrl.searchParams) if (!out.searchParams.has(k)) out.searchParams.append(k, v);
  return out.href;
}

function report(tabId, percent, phase, current, total, text) {
  chrome.runtime.sendMessage({ type: 'HLS_PROGRESS', tabId, percent, phase, current, total, text }).catch(() => {});
}

async function fetchWithRetry(url, label, retries = 2) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} while loading ${label}`);
      if (![401,403,404,408,429,500,502,503,504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    if (attempt < retries) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  throw last || new Error(`Failed while loading ${label}`);
}

async function fetchText(url) { return (await fetchWithRetry(url, 'playlist')).text(); }

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/), variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (lines[j]) variants.push({ url: abs(base, lines[j].trim()), bw });
  }
  return variants.sort((a,b) => b.bw - a.bw);
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/), urls = [];
  let mapUrl = null, encrypted = false, endList = false, duration = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) encrypted = true;
    if (line === '#EXT-X-ENDLIST') endList = true;
    if (line.startsWith('#EXTINF:')) duration += Number((line.match(/^#EXTINF:([0-9.]+)/) || [])[1] || 0);
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/i);
      if (m) mapUrl = abs(base, m[1]);
    } else if (!line.startsWith('#')) urls.push(abs(base, line));
  }
  return { mapUrl, urls, encrypted, endList, duration };
}

async function loadHls(url) {
  const text = await fetchText(url);
  const variants = parseMaster(text, url);
  if (variants.length) {
    let lastError;
    for (const variant of variants) {
      try {
        const parsed = parseMedia(await fetchText(variant.url), variant.url);
        if (parsed.urls.length) return { playlistUrl: variant.url, ...parsed };
      } catch (e) { lastError = e; }
    }
    if (lastError) throw lastError;
  }
  return { playlistUrl: url, ...parseMedia(text, url) };
}

async function fetchBuffer(url) {
  return new Uint8Array(await (await fetchWithRetry(url, 'video segment')).arrayBuffer());
}

function concat(parts) {
  const size = parts.reduce((n,p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

async function downloadHls(url, filenameBase, tabId) {
  report(tabId, 1, 'playlist', 0, 0, 'Reading lesson playlist…');
  let info = await loadHls(url);
  if (info.encrypted) throw new Error('This HLS stream is encrypted/DRM-protected and cannot be assembled by this extension.');
  if (!info.urls.length) throw new Error('No HLS video segments found.');

  if (!info.endList && (info.urls.length < 3 || info.duration < 8)) {
    report(tabId, 2, 'playlist', 0, 0, 'Waiting for the full lesson playlist…');
    await new Promise(r => setTimeout(r, 1800));
    info = await loadHls(info.playlistUrl);
  }

  const chunks = [];
  const total = info.urls.length + (info.mapUrl ? 1 : 0);
  let completed = 0;
  if (info.mapUrl) {
    chunks.push(await fetchBuffer(info.mapUrl));
    completed++;
  }
  for (let i = 0; i < info.urls.length; i++) {
    chunks.push(await fetchBuffer(info.urls[i]));
    completed++;
    const pct = Math.max(3, Math.min(92, Math.round((completed / total) * 90) + 2));
    report(tabId, pct, 'download', completed, total, `Downloading video… ${completed}/${total} segments (${pct}%)`);
  }

  const firstPath = new URL(info.urls[0]).pathname.toLowerCase();
  const fragmentedMp4 = !!info.mapUrl || /\.m4s$|\.mp4$/i.test(firstPath);
  report(tabId, 96, 'assemble', total, total, fragmentedMp4
    ? 'Assembling original MP4 fragments… 96%'
    : 'Joining original video segments… 96%');
  const bytes = concat(chunks);

  if (bytes.byteLength < 100000) throw new Error('The detected stream is only a tiny preview/partial clip. The extension will auto-play the lesson to detect the full stream; try again after a few seconds.');

  const blob = new Blob([bytes], { type: fragmentedMp4 ? 'video/mp4' : 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `${filenameBase}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  report(tabId, 100, 'done', total, total, `Complete — ${filenameBase}.mp4`);
  return { ok: true, message: `Full lesson downloaded as ${filenameBase}.mp4` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg?.type !== 'DOWNLOAD_HLS') return;
  downloadHls(msg.url, msg.filenameBase, msg.tabId)
    .then(sendResponse)
    .catch(err => {
      report(msg.tabId, 0, 'error', 0, 0, `Download failed: ${err.message || String(err)}`);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true;
});
