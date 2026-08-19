(() => {
  function concat(parts) {
    const size = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
    return out;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'TRANSMUX_TS_SEGMENTS' || !msg.id) return;

    try {
      if (!window.muxjs?.mp4?.Transmuxer) {
        throw new Error('MP4 converter library did not load. Check internet access and try again.');
      }

      const transmuxer = new window.muxjs.mp4.Transmuxer({
        remux: true,
        keepOriginalTimestamps: false
      });

      const parts = [];
      let initAdded = false;
      let dataEvents = 0;
      let videoSeen = false;
      let audioSeen = false;

      transmuxer.on('data', (segment) => {
        dataEvents++;
        const type = String(segment.type || '').toLowerCase();
        if (type.includes('video') || type === 'combined') videoSeen = true;
        if (type.includes('audio') || type === 'combined') audioSeen = true;

        if (!initAdded && segment.initSegment?.byteLength) {
          parts.push(new Uint8Array(segment.initSegment));
          initAdded = true;
        }
        if (segment.data?.byteLength) parts.push(new Uint8Array(segment.data));
      });

      const buffers = Array.isArray(msg.buffers) ? msg.buffers : [];
      if (!buffers.length) throw new Error('No TS segments were supplied to the MP4 converter.');

      for (const buffer of buffers) {
        if (!buffer || !buffer.byteLength) continue;
        transmuxer.push(new Uint8Array(buffer));
        transmuxer.flush();
      }

      if (!parts.length || !initAdded || dataEvents === 0) {
        throw new Error('TS stream could not be converted to MP4.');
      }

      const output = concat(parts);
      parent.postMessage({
        type: 'TRANSMUX_RESULT',
        id: msg.id,
        ok: true,
        buffer: output.buffer,
        stats: { dataEvents, videoSeen, audioSeen }
      }, '*', [output.buffer]);
    } catch (err) {
      parent.postMessage({
        type: 'TRANSMUX_RESULT',
        id: msg.id,
        ok: false,
        error: err.message || String(err)
      }, '*');
    }
  });
})();
