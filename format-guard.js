(() => {
  const originalSaveBlob = globalThis.saveBlob;
  if (typeof originalSaveBlob !== 'function') return;

  globalThis.saveBlob = function guardedSaveBlob(bytes, type, filename) {
    let safeName = filename;
    const mime = String(type || '').toLowerCase();
    if (/video\/mp2t|mpegurl-ts|mp2t/.test(mime) && /\.mp4$/i.test(safeName || '')) {
      safeName = safeName.replace(/\.mp4$/i, '.ts');
    }
    return originalSaveBlob(bytes, type, safeName);
  };
})();
