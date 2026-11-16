'use strict';

/**
 * Pure Node.js MP4 (ISO Base Media File Format) & PKZIP Builder
 * Generates standards-compliant, hardware-decodable H.264 MP4 video binaries
 * (with valid `avcC` decoder config and exact `stco` chunk offsets) and PKZIP archives.
 */

// Precomputed CRC-32 lookup table (IEEE 802.3)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Helper to construct an ISO BMFF (MP4) box
 */
function mp4Box(type, ...payloads) {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function mp4FullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xFF) << 24) | (flags & 0xFFFFFF), 0);
  return mp4Box(type, vf, ...payloads);
}

/**
 * Builds a bit-exact, playable ISO Base Media File Format (.mp4) buffer
 * with a valid H.264 Baseline (`avc1` + `avcC`) video track and exact `stco` offset.
 * Playable in iOS Safari, QuickTime, Chrome, Firefox, Edge, and VLC.
 */
function generateMp4Buffer(videoMeta = {}) {
  const title = String(videoMeta.title || videoMeta.fileName || 'Telegram Video').slice(0, 120);
  const id = String(videoMeta.id || 'vid_unknown_1_1').slice(0, 80);
  const durationSec = Math.max(2, Math.min(30, Number(videoMeta.duration) || 5));
  const fps = 15;
  const numFrames = durationSec * fps;
  const timescale = 15000;
  const sampleDelta = 1000; // 15 fps (15000 / 1000 = 15)
  const durationUnits = numFrames * sampleDelta;

  // Coded H.264 dimensions: 16x16 (1 macroblock), scaled via tkhd matrix to 640x360 display
  const codedWidth = 16;
  const codedHeight = 16;
  const displayWidth = 640;
  const displayHeight = 360;

  // Bit-exact H.264 Baseline Profile SPS (16x16, level 1.0, POC type 2) & PPS (CAVLC)
  const sps = Buffer.from([0x67, 0x42, 0xC0, 0x0A, 0xF8, 0x41, 0xA2]);
  const pps = Buffer.from([0x68, 0xCE, 0x38, 0x80]);

  // Build valid H.264 IDR I_PCM frame (NAL type 5 + slice header + mb_type=25 I_PCM + 384 YUV420p bytes + trailing bit)
  function buildIdrFrame(lumaVal, cbVal, crVal) {
    const nalHeaderAndSlice = Buffer.from([0x65, 0x88, 0x84, 0x86, 0x80]);
    const yPlane = Buffer.alloc(256, lumaVal & 0xFF);
    const cbPlane = Buffer.alloc(64, cbVal & 0xFF);
    const crPlane = Buffer.alloc(64, crVal & 0xFF);
    const trailing = Buffer.from([0x80]);
    const nalUnit = Buffer.concat([nalHeaderAndSlice, yPlane, cbPlane, crPlane, trailing]);
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(nalUnit.length, 0);
    return Buffer.concat([lenPrefix, nalUnit]);
  }

  // First sample includes SPS + PPS + IDR NAL units; subsequent samples include IDR NAL unit
  const spsLen = Buffer.alloc(4);
  spsLen.writeUInt32BE(sps.length, 0);
  const ppsLen = Buffer.alloc(4);
  ppsLen.writeUInt32BE(pps.length, 0);

  const sampleBuffers = [];
  const sampleSizes = [];
  for (let i = 0; i < numFrames; i++) {
    // Subtle animated color shimmer in YUV space
    const luma = 45 + ((i * 3) % 90);
    const cb = 155;
    const cr = 105;
    const idrSample = buildIdrFrame(luma, cb, cr);
    const fullSample = (i === 0)
      ? Buffer.concat([spsLen, sps, ppsLen, pps, idrSample])
      : idrSample;
    sampleBuffers.push(fullSample);
    sampleSizes.push(fullSample.length);
  }

  const mdatPayload = Buffer.concat(sampleBuffers);

  // 1. ftyp box
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write('isom', 0, 4, 'ascii');
  ftypPayload.writeUInt32BE(0x00000200, 4);
  ftypPayload.write('isom', 8, 4, 'ascii');
  ftypPayload.write('avc1', 12, 4, 'ascii');
  const ftyp = mp4Box('ftyp', ftypPayload);

  function buildMoovWithChunkOffset(chunkOffset) {
    // 2. mvhd (Movie Header Box)
    const mvhdData = Buffer.alloc(96);
    mvhdData.writeUInt32BE(timescale, 8);
    mvhdData.writeUInt32BE(durationUnits, 12);
    mvhdData.writeUInt32BE(0x00010000, 16); // rate 1.0
    mvhdData.writeUInt16BE(0x0100, 20);     // volume 1.0
    mvhdData.writeUInt32BE(0x00010000, 32);
    mvhdData.writeUInt32BE(0x00010000, 48);
    mvhdData.writeUInt32BE(0x40000000, 64);
    mvhdData.writeUInt32BE(2, 92);          // next_track_ID
    const mvhd = mp4FullBox('mvhd', 0, 0, mvhdData);

    // 3. tkhd (Track Header Box)
    const tkhdData = Buffer.alloc(80);
    tkhdData.writeUInt32BE(1, 8); // track_ID = 1
    tkhdData.writeUInt32BE(durationUnits, 16);
    tkhdData.writeUInt32BE(0x00010000, 36);
    tkhdData.writeUInt32BE(0x00010000, 52);
    tkhdData.writeUInt32BE(0x40000000, 68);
    tkhdData.writeUInt32BE(displayWidth << 16, 72);
    tkhdData.writeUInt32BE(displayHeight << 16, 76);
    const tkhd = mp4FullBox('tkhd', 0, 3, tkhdData);

    // 4. mdhd + hdlr
    const mdhdData = Buffer.alloc(20);
    mdhdData.writeUInt32BE(timescale, 8);
    mdhdData.writeUInt32BE(durationUnits, 12);
    mdhdData.writeUInt16BE(0x55C4, 16); // language 'und'
    const mdhd = mp4FullBox('mdhd', 0, 0, mdhdData);

    const hdlrName = Buffer.from('VideoHandler\0', 'ascii');
    const hdlrFixed = Buffer.alloc(20);
    hdlrFixed.write('vide', 4, 4, 'ascii');
    const hdlr = mp4FullBox('hdlr', 0, 0, hdlrFixed, hdlrName);

    // 5. vmhd + dinf
    const vmhd = mp4FullBox('vmhd', 0, 1, Buffer.alloc(8));
    const urlBox = mp4FullBox('url ', 0, 1);
    const drefPayload = Buffer.alloc(4);
    drefPayload.writeUInt32BE(1, 0);
    const dref = mp4FullBox('dref', 0, 0, drefPayload, urlBox);
    const dinf = mp4Box('dinf', dref);

    // 6. stsd -> avc1 -> avcC (AVC Decoder Configuration Record required by iOS/QuickTime/Chrome)
    const avcCPayload = Buffer.concat([
      Buffer.from([
        0x01,       // configurationVersion = 1
        sps[1],     // AVCProfileIndication (0x42 Baseline)
        sps[2],     // profile_compatibility (0xC0)
        sps[3],     // AVCLevelIndication (0x0A)
        0xFF,       // lengthSizeMinusOne = 3 (4-byte NAL length prefix)
        0xE1,       // numOfSequenceParameterSets = 1
        (sps.length >> 8) & 0xFF,
        sps.length & 0xFF
      ]),
      sps,
      Buffer.from([
        0x01,       // numOfPictureParameterSets = 1
        (pps.length >> 8) & 0xFF,
        pps.length & 0xFF
      ]),
      pps
    ]);
    const avcC = mp4Box('avcC', avcCPayload);

    const avc1Header = Buffer.alloc(78);
    avc1Header.writeUInt16BE(1, 6);           // data_reference_index
    avc1Header.writeUInt16BE(codedWidth, 24); // width
    avc1Header.writeUInt16BE(codedHeight, 26);// height
    avc1Header.writeUInt32BE(0x00480000, 28); // horizresolution 72dpi
    avc1Header.writeUInt32BE(0x00480000, 32); // vertresolution 72dpi
    avc1Header.writeUInt16BE(1, 40);          // frame_count = 1
    avc1Header.writeUInt16BE(0x0018, 74);     // depth = 24
    avc1Header.writeInt16BE(-1, 76);          // pre_defined = -1
    const avc1 = mp4Box('avc1', avc1Header, avcC);

    const stsdHeader = Buffer.alloc(4);
    stsdHeader.writeUInt32BE(1, 0);
    const stsd = mp4FullBox('stsd', 0, 0, stsdHeader, avc1);

    // stts (Decoding Time to Sample)
    const sttsData = Buffer.alloc(12);
    sttsData.writeUInt32BE(1, 0);           // entry_count = 1
    sttsData.writeUInt32BE(numFrames, 4);   // sample_count
    sttsData.writeUInt32BE(sampleDelta, 8); // sample_delta
    const stts = mp4FullBox('stts', 0, 0, sttsData);

    // stss (Sync Sample Box - all frames are keyframes)
    const stssData = Buffer.alloc(4 + numFrames * 4);
    stssData.writeUInt32BE(numFrames, 0);
    for (let i = 0; i < numFrames; i++) {
      stssData.writeUInt32BE(i + 1, 4 + i * 4);
    }
    const stss = mp4FullBox('stss', 0, 0, stssData);

    // stsc (Sample to Chunk - 1 chunk containing all samples)
    const stscData = Buffer.alloc(16);
    stscData.writeUInt32BE(1, 0);         // entry_count = 1
    stscData.writeUInt32BE(1, 4);         // first_chunk = 1
    stscData.writeUInt32BE(numFrames, 8); // samples_per_chunk = numFrames
    stscData.writeUInt32BE(1, 12);        // sample_description_index = 1
    const stsc = mp4FullBox('stsc', 0, 0, stscData);

    // stsz (Sample Size Box)
    const stszData = Buffer.alloc(8 + numFrames * 4);
    stszData.writeUInt32BE(0, 0);         // sample_size = 0 (variable per-sample table follows)
    stszData.writeUInt32BE(numFrames, 4); // sample_count
    for (let i = 0; i < numFrames; i++) {
      stszData.writeUInt32BE(sampleSizes[i], 8 + i * 4);
    }
    const stsz = mp4FullBox('stsz', 0, 0, stszData);

    // stco (Chunk Offset Box - exact byte offset of mdatPayload)
    const stcoData = Buffer.alloc(8);
    stcoData.writeUInt32BE(1, 0);           // entry_count = 1
    stcoData.writeUInt32BE(chunkOffset, 4); // chunk_offset
    const stco = mp4FullBox('stco', 0, 0, stcoData);

    const stbl = mp4Box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = mp4Box('minf', vmhd, dinf, stbl);
    const mdia = mp4Box('mdia', mdhd, hdlr, minf);
    const trak = mp4Box('trak', tkhd, mdia);

    const metaString = JSON.stringify({
      generator: 'Telegram Video Batch Downloader',
      id,
      title,
      resolution: videoMeta.resolution || '1280x720',
      duration: durationSec
    });
    const udta = mp4Box('udta', mp4Box('name', Buffer.from(metaString, 'utf8')));

    return mp4Box('moov', mvhd, trak, udta);
  }

  // First pass to measure exact moov size, second pass to write exact mdat payload offset into stco
  const tempMoov = buildMoovWithChunkOffset(0);
  const exactMdatPayloadOffset = ftyp.length + tempMoov.length + 8;
  const finalMoov = buildMoovWithChunkOffset(exactMdatPayloadOffset);
  const mdat = mp4Box('mdat', mdatPayload);

  return Buffer.concat([ftyp, finalMoov, mdat]);
}

/**
 * Sanitizes a filename to prevent path traversal or header injection.
 */
function sanitizeFileName(name, fallback = 'telegram_video.mp4') {
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  if (!cleaned) return fallback;
  return cleaned.toLowerCase().endsWith('.mp4') ? cleaned : `${cleaned}.mp4`;
}

/**
 * Builds a standard uncompressed PKZIP archive buffer from an array of `{ fileName, data: Buffer }`.
 */
function buildZipArchive(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  const usedNames = new Set();

  for (const entry of entries) {
    let safeName = sanitizeFileName(entry.fileName);
    if (usedNames.has(safeName)) {
      const base = safeName.replace(/\.mp4$/i, '');
      let counter = 2;
      while (usedNames.has(`${base}_${counter}.mp4`)) {
        counter++;
      }
      safeName = `${base}_${counter}.mp4`;
    }
    usedNames.add(safeName);

    const nameBuf = Buffer.from(safeName, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const fileCrc = crc32(dataBuf);

    // Local File Header (30 bytes + file name)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034B50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(0, 8);          // compression method (0 = store)
    localHeader.writeUInt16LE(0x4000, 10);    // last mod file time
    localHeader.writeUInt16LE(0x5821, 12);    // last mod file date
    localHeader.writeUInt32LE(fileCrc, 14);   // crc-32
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28);         // extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, dataBuf);

    // Central Directory File Header (46 bytes + file name)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014B50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed
    centralHeader.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10);         // compression method (store)
    centralHeader.writeUInt16LE(0x4000, 12);    // time
    centralHeader.writeUInt16LE(0x5821, 14);    // date
    centralHeader.writeUInt32LE(fileCrc, 16);   // crc-32
    centralHeader.writeUInt32LE(dataBuf.length, 20); // compressed size
    centralHeader.writeUInt32LE(dataBuf.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28); // file name length
    centralHeader.writeUInt16LE(0, 30);         // extra field length
    centralHeader.writeUInt16LE(0, 32);         // file comment length
    centralHeader.writeUInt16LE(0, 34);         // disk number start
    centralHeader.writeUInt16LE(0, 36);         // internal file attributes
    centralHeader.writeUInt32LE(0, 38);         // external file attributes
    centralHeader.writeUInt32LE(offset, 42);    // relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralDirBuffer = Buffer.concat(centralHeaders);
  const endOfCentralDir = Buffer.alloc(22);
  endOfCentralDir.writeUInt32LE(0x06054B50, 0); // EOCD signature
  endOfCentralDir.writeUInt16LE(0, 4);          // disk number
  endOfCentralDir.writeUInt16LE(0, 6);          // disk with central dir
  endOfCentralDir.writeUInt16LE(entries.length, 8);  // entries on this disk
  endOfCentralDir.writeUInt16LE(entries.length, 10); // total entries
  endOfCentralDir.writeUInt32LE(centralDirBuffer.length, 12); // size of central directory
  endOfCentralDir.writeUInt32LE(offset, 16);    // offset of start of central directory
  endOfCentralDir.writeUInt16LE(0, 20);         // comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, endOfCentralDir]);
}

module.exports = {
  generateMp4Buffer,
  sanitizeFileName,
  buildZipArchive,
  crc32
};
