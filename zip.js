/* zip.js — minimal ZIP writer (STORE, no compression).
 *
 * WHY THIS EXISTS AS A SEPARATE CLASSIC SCRIPT:
 *   1. app.js is a MODULE, so anything defined in it is module-scoped and cannot
 *      be exercised from the console or from a test harness. A ZIP writer that
 *      cannot be tested is a ZIP writer that fails silently on the athlete's
 *      phone, where the failure costs the whole session's photos.
 *   2. No dependency — this must work fully offline from the service worker.
 *      A CDN copy of JSZip would break the moment he is in a basement gym.
 *
 * WHY STORE AND NOT DEFLATE: the payload is JPEGs, which are already compressed.
 * Recompressing them costs CPU, gains ~0%, and would need a real DEFLATE
 * implementation. STORE keeps this to ~60 lines with no risk of a corrupt
 * stream.
 *
 * Exposed: window.makeZip(files) -> Blob, window.crc32(bytes) -> uint32
 *   files: [{ name: 'photos/01_pose.jpg', data: Uint8Array }]
 */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [];
    var offset = 0;
    var d = new Date();
    var dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nb = enc.encode(f.name);
      var crc = crc32(f.data);
      var n = f.data.length;

      // ---- local file header (30 bytes) ----
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);   // signature
      lh.setUint16(4, 20, true);           // version needed
      lh.setUint16(6, 0, true);            // flags
      lh.setUint16(8, 0, true);            // method 0 = STORE
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, n, true);           // compressed size == n (stored)
      lh.setUint32(22, n, true);           // uncompressed size
      lh.setUint16(26, nb.length, true);
      lh.setUint16(28, 0, true);           // extra length
      parts.push(new Uint8Array(lh.buffer), nb, f.data);

      // ---- central directory entry (46 bytes) ----
      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);   // signature
      cd.setUint16(4, 20, true);           // version made by
      cd.setUint16(6, 20, true);           // version needed
      cd.setUint16(8, 0, true);            // flags
      cd.setUint16(10, 0, true);           // method
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, n, true);
      cd.setUint32(24, n, true);
      cd.setUint16(28, nb.length, true);
      cd.setUint16(30, 0, true);           // extra
      cd.setUint16(32, 0, true);           // comment
      cd.setUint16(34, 0, true);           // disk number
      cd.setUint16(36, 0, true);           // internal attrs
      cd.setUint32(38, 0, true);           // external attrs
      cd.setUint32(42, offset, true);      // offset of local header
      central.push(new Uint8Array(cd.buffer), nb);

      offset += 30 + nb.length + n;
    }

    var cdSize = 0;
    for (var j = 0; j < central.length; j++) cdSize += central[j].length;

    // ---- end of central directory (22 bytes) ----
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);            // disk
    eocd.setUint16(6, 0, true);            // disk with CD
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);           // comment length

    return new Blob([].concat(parts, central, [new Uint8Array(eocd.buffer)]),
                    { type: 'application/zip' });
  }

  global.makeZip = makeZip;
  global.crc32 = crc32;
})(window);
