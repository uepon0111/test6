/**
 * storage.js — IndexedDB wrapper + multi-format audio metadata for Sonora
 *
 * BUG FIXES / NEW FEATURES:
 *   - TDRC / TDRL: 年のみでなく YYYY-MM-DD の完全な日付を保持
 *   - APIC: 複数フレームを picture type で分類
 *       type 3 (Front Cover) → thumbData（サムネイル）
 *       type 8 (Artist)      → artistIconData（アーティストアイコン）
 *       type 1/2 (Icon)      → artistIconData（代替アイコン）
 *       それ以外は type 3 がなければフォールバック
 *   - parseAudioMetaFromBuffer / readAudioMeta が返すオブジェクトに
 *     artistIconData / artistIconMime を追加
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 2;
  const STORES     = ['tracks','blobs','playlists','tags','logs','meta','artists'];
  let _db = null;

  /* ═══════════════════════════════════════════════════════════
     INDEXEDDB
  ══════════════════════════════════════════════════════════ */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const ts = db.createObjectStore('tracks', { keyPath:'id' });
          ts.createIndex('by_artist',  'artist',      { unique:false });
          ts.createIndex('by_title',   'title',       { unique:false });
          ts.createIndex('by_added',   'dateAdded',   { unique:false });
          ts.createIndex('by_release', 'releaseDate', { unique:false });
          ts.createIndex('by_order',   'manualOrder', { unique:false });
        }
        if (!db.objectStoreNames.contains('blobs'))
          db.createObjectStore('blobs', { keyPath:'key' });
        if (!db.objectStoreNames.contains('playlists')) {
          const ps = db.createObjectStore('playlists', { keyPath:'id' });
          ps.createIndex('by_created','createdAt',{ unique:false });
        }
        if (!db.objectStoreNames.contains('tags')) {
          const tgs = db.createObjectStore('tags', { keyPath:'id' });
          tgs.createIndex('by_order','order',{ unique:false });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath:'id' });
          ls.createIndex('by_track',   'trackId',  { unique:false });
          ls.createIndex('by_playedAt','playedAt', { unique:false });
        }
        if (!db.objectStoreNames.contains('meta'))
          db.createObjectStore('meta', { keyPath:'key' });
        if (!db.objectStoreNames.contains('artists')) {
          const as = db.createObjectStore('artists', { keyPath:'id' });
          as.createIndex('by_name','name',{ unique:false });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function tx(s, mode='readonly') { return _db.transaction(s, mode).objectStore(s); }
  function req2p(r) {
    return new Promise((res,rej) => {
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e.target.error);
    });
  }
  function getAll(s, idx, q) {
    const store = tx(s);
    return req2p((idx ? store.index(idx) : store).getAll(q));
  }
  const getOne     = (s,k)   => req2p(tx(s).get(k));
  const put        = (s,obj) => req2p(tx(s,'readwrite').put(obj));
  const del        = (s,k)   => req2p(tx(s,'readwrite').delete(k));
  const clearStore = s       => req2p(tx(s,'readwrite').clear());
  const uid        = ()      => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  /* ═══════════════════════════════════════════════════════════
     TRACKS
  ══════════════════════════════════════════════════════════ */
  const getTracks = () => getAll('tracks');
  const getTrack  = id => getOne('tracks', id);

  async function addTrack(data) {
    const existing = await getTracks();
    const maxOrder = existing.reduce((m,t) => Math.max(m, t.manualOrder||0), 0);
    const track = {
      id:           data.id           || uid(),
      title:        data.title        || '不明なタイトル',
      artist:       data.artist       || '',
      dateAdded:    data.dateAdded    || Date.now(),
      releaseDate:  data.releaseDate  || null,
      tags:         data.tags         || [],
      manualOrder:  data.manualOrder  || (maxOrder + 1),
      driveFileId:  data.driveFileId  || null,
      driveThumbId: data.driveThumbId || null,
      blobKey:      data.blobKey      || null,
      thumbKey:     data.thumbKey     || null,
      duration:     data.duration     || 0,
    };
    await put('tracks', track);
    return track;
  }

  async function updateTrack(id, changes) {
    const track = await getTrack(id);
    if (!track) throw new Error('Track not found: ' + id);
    const updated = { ...track, ...changes };
    await put('tracks', updated);
    return updated;
  }

  async function deleteTrack(id) {
    const track = await getTrack(id);
    if (!track) return;
    const pls = await getPlaylists();
    for (const pl of pls)
      if (pl.trackIds.includes(id))
        await updatePlaylist(pl.id, { trackIds: pl.trackIds.filter(t => t !== id) });
    if (track.blobKey)  await del('blobs', track.blobKey);
    if (track.thumbKey) await del('blobs', track.thumbKey);
    const logs = await getAll('logs','by_track', id);
    for (const l of logs) await del('logs', l.id);
    await del('tracks', id);
  }

  function reorderTracks(orderedIds) {
    return new Promise((resolve, reject) => {
      const t     = _db.transaction('tracks', 'readwrite');
      const store = t.objectStore('tracks');
      t.oncomplete = () => resolve();
      t.onerror    = e  => reject(e.target.error);
      t.onabort    = e  => reject(new Error('reorderTracks aborted'));
      orderedIds.forEach((id, idx) => {
        const r = store.get(id);
        r.onsuccess = e => {
          const track = e.target.result;
          if (track) { track.manualOrder = idx + 1; store.put(track); }
        };
        r.onerror = () => t.abort();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BLOBS
  ══════════════════════════════════════════════════════════ */
  async function saveBlob(data) {
    if (!data) throw new Error('saveBlob: data is null/undefined');
    const key = 'blob_' + uid();
    await put('blobs', { key, data });
    return key;
  }
  async function getBlob(key) {
    if (!key) return null;
    const rec = await getOne('blobs', key);
    return rec ? rec.data : null;
  }
  const deleteBlob = key => key ? del('blobs', key) : Promise.resolve();

  /**
   * BUG FIX: バイナリデータの先頭バイト（マジックバイト）から MIME タイプを検出する。
   * MIMEタイプなしの Blob URL を Chrome に渡すと audio/image が正しく再生・表示されない
   * 問題（スキップ・サムネイル未表示）を修正。
   */
  function _detectMime(data) {
    let b;
    try {
      if (data instanceof ArrayBuffer) {
        b = new Uint8Array(data, 0, Math.min(16, data.byteLength));
      } else if (ArrayBuffer.isView(data)) {
        b = new Uint8Array(data.buffer, data.byteOffset, Math.min(16, data.byteLength));
      } else {
        return 'application/octet-stream';
      }
    } catch { return 'application/octet-stream'; }

    // ── 画像 ──────────────────────────────────────────────────────
    if (b[0] === 0xFF && b[1] === 0xD8)                           return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E)         return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)         return 'image/gif';
    // WebP: "RIFF....WEBP"
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';

    // ── 音声 ──────────────────────────────────────────────────────
    // ID3v2 タグで始まる MP3
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)         return 'audio/mpeg';
    // MPEG フレーム同期 (0xFF 0xEx or 0xFF 0xFx)
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)                  return 'audio/mpeg';
    // FLAC: "fLaC"
    if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61)         return 'audio/flac';
    // OGG: "OggS"
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67)         return 'audio/ogg';
    // M4A/AAC: ftyp atom (offset 4)
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4';

    return 'application/octet-stream';
  }

  async function getBlobUrl(key) {
    const data = await getBlob(key);
    if (!data) return null;
    const mime = _detectMime(data);
    return URL.createObjectURL(new Blob([data], { type: mime }));
  }
  async function getAudioBlobUrl(trackId) {
    const t = await getTrack(trackId);
    if (!t?.blobKey) return null;
    const data = await getBlob(t.blobKey);
    if (!data) return null;
    // 音声は常に audio/mpeg をフォールバックとして使用（Chrome の厳格な MIME チェック対策）
    let mime = _detectMime(data);
    if (!mime.startsWith('audio/')) mime = 'audio/mpeg';
    return URL.createObjectURL(new Blob([data], { type: mime }));
  }

  /* ═══════════════════════════════════════════════════════════
     PLAYLISTS
  ══════════════════════════════════════════════════════════ */
  const getPlaylists  = ()  => getAll('playlists');
  const getPlaylist   = id  => getOne('playlists', id);
  async function createPlaylist(name, desc='') {
    const pl = { id:uid(), name:name.trim()||'新しいプレイリスト', desc, trackIds:[], createdAt:Date.now() };
    await put('playlists', pl); return pl;
  }
  async function updatePlaylist(id, changes) {
    const pl = await getPlaylist(id);
    if (!pl) throw new Error('Playlist not found: ' + id);
    const updated = { ...pl, ...changes };
    await put('playlists', updated); return updated;
  }
  const deletePlaylist = id => del('playlists', id);
  async function addTrackToPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl || pl.trackIds.includes(tid)) return;
    await updatePlaylist(pid, { trackIds:[...pl.trackIds, tid] });
  }
  async function removeTrackFromPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl) return;
    await updatePlaylist(pid, { trackIds: pl.trackIds.filter(id => id !== tid) });
  }

  /* ═══════════════════════════════════════════════════════════
     TAGS
  ══════════════════════════════════════════════════════════ */
  async function getTags() {
    const tags = await getAll('tags','by_order');
    return tags.sort((a,b) => (a.order||0)-(b.order||0));
  }
  const getTag = id => getOne('tags', id);
  async function createTag(name, color='#DBEAFE', textColor='#1D4ED8') {
    const existing = await getTags();
    const tag = { id:uid(), name:name.trim(), color, textColor, order:existing.length };
    await put('tags', tag); return tag;
  }
  async function updateTag(id, changes) {
    const tag = await getTag(id);
    if (!tag) throw new Error('Tag not found: ' + id);
    const updated = { ...tag, ...changes };
    await put('tags', updated); return updated;
  }
  async function deleteTag(id) {
    const tracks = await getTracks();
    for (const t of tracks)
      if ((t.tags||[]).includes(id))
        await updateTrack(t.id, { tags: t.tags.filter(g => g !== id) });
    await del('tags', id);
  }
  function reorderTags(orderedIds) {
    return new Promise((resolve, reject) => {
      const t     = _db.transaction('tags', 'readwrite');
      const store = t.objectStore('tags');
      t.oncomplete = () => resolve();
      t.onerror    = e => reject(e.target.error);
      t.onabort    = () => reject(new Error('reorderTags aborted'));
      orderedIds.forEach((id, idx) => {
        const r = store.get(id);
        r.onsuccess = e => {
          const tag = e.target.result;
          if (tag) store.put({ ...tag, order: idx });
        };
        r.onerror = () => t.abort();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     ARTISTS
  ══════════════════════════════════════════════════════════ */
  const getArtists = () => getAll('artists');
  const getArtist  = id => getOne('artists', id);

  async function createArtist(name, { iconKey=null, color='#DBEAFE', textColor='#1E40AF' } = {}) {
    const existing = await getArtists();
    const artist = {
      id: uid(),
      name: name.trim(),
      iconKey,
      color,
      textColor,
      order: existing.length,
      createdAt: Date.now(),
    };
    await put('artists', artist);
    return artist;
  }

  async function updateArtist(id, changes) {
    const existing = await getOne('artists', id);
    if (!existing) return;
    await put('artists', { ...existing, ...changes });
  }

  async function deleteArtist(id) {
    const artist = await getOne('artists', id);
    if (artist?.iconKey) await del('blobs', artist.iconKey).catch(() => {});
    await del('artists', id);
    const tracks = await getTracks();
    for (const t of tracks) {
      const artists = (t.artists || []).filter(n => n !== artist?.name);
      if (artists.length !== (t.artists || []).length) {
        await put('tracks', { ...t, artists, artist: artists[0] || t.artist });
      }
    }
  }

  /**
   * 名前でアーティストを検索（なければ null）
   */
  async function getArtistByName(name) {
    const all = await getArtists();
    return all.find(a => a.name === name) || null;
  }

  /**
   * アーティストを名前で取得。存在しなければ新規作成する。
   * @returns {object} アーティストレコード
   */
  async function getOrCreateArtist(name, options = {}) {
    if (!name || !name.trim()) return null;
    const existing = await getArtistByName(name.trim());
    if (existing) return existing;
    return createArtist(name.trim(), options);
  }

  async function reorderArtists(ids) {
    return new Promise((resolve, reject) => {
      const t = _db.transaction('artists', 'readwrite');
      t.oncomplete = resolve;
      t.onerror    = () => reject(t.error);
      const store  = t.objectStore('artists');
      ids.forEach((id, idx) => {
        const r = store.get(id);
        r.onsuccess = e => {
          const a = e.target.result;
          if (a) store.put({ ...a, order: idx });
        };
        r.onerror = () => t.abort();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     LOGS
  ══════════════════════════════════════════════════════════ */
  const getLogs = () => getAll('logs');
  async function addLog(trackId, dur=0) {
    const log = { id:uid(), trackId, playedAt:Date.now(), duration:dur };
    await put('logs', log);
    return log;
  }
  async function addLogRaw(log) {
    if (!log || !log.id) return;
    await put('logs', log);
  }

  /* ═══════════════════════════════════════════════════════════
     META
  ══════════════════════════════════════════════════════════ */
  async function getMeta(key, fallback=null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }
  const setMeta    = (k,v) => put('meta', { key:k, value:v });
  const deleteMeta = k     => del('meta', k);

  /* ═══════════════════════════════════════════════════════════
     SNAPSHOT
  ══════════════════════════════════════════════════════════ */
  async function exportSnapshot() {
    const [tracks, playlists, tags, logs, artists] = await Promise.all([
      getTracks(), getPlaylists(), getTags(), getLogs(), getArtists()
    ]);
    return {
      version:    2,
      exportedAt: Date.now(),
      tracks:     tracks.map(({ blobKey, thumbKey, ...rest }) => rest),
      playlists, tags, logs, artists,
    };
  }
  async function importSnapshot(snapshot) {
    if (!snapshot || (snapshot.version !== 1 && snapshot.version !== 2)) return;
    for (const t of snapshot.tracks||[]) {
      const ex = await getTrack(t.id);
      if (!ex) await put('tracks', { ...t, blobKey:null, thumbKey:null });
    }
    for (const pl of snapshot.playlists||[]) {
      const ex = await getPlaylist(pl.id);
      if (!ex) await put('playlists', pl);
      else await put('playlists', { ...ex, trackIds:[...new Set([...ex.trackIds,...pl.trackIds])] });
    }
    for (const tag of snapshot.tags||[]) {
      if (!(await getTag(tag.id))) await put('tags', tag);
    }
    for (const artist of snapshot.artists||[]) {
      if (!(await getArtist(artist.id))) await put('artists', { ...artist, iconKey: null });
    }
    const exIds = new Set((await getLogs()).map(l => l.id));
    for (const log of snapshot.logs||[])
      if (!exIds.has(log.id)) await put('logs', log);
  }
  async function resetAll() {
    for (const s of STORES) await clearStore(s);
  }

  /* ═══════════════════════════════════════════════════════════
     LOW-LEVEL BINARY HELPERS
  ══════════════════════════════════════════════════════════ */
  function _u32be(b, o) { return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) >>> 0; }
  function _u32le(b, o) { return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24)) >>> 0; }
  function _imgMime(b, o=0) {
    if (b[o]===0xFF && b[o+1]===0xD8) return 'image/jpeg';
    if (b[o]===0x89 && b[o+1]===0x50 && b[o+2]===0x4E && b[o+3]===0x47) return 'image/png';
    if (b[o]===0x47 && b[o+1]===0x49 && b[o+2]===0x46) return 'image/gif';
    if (b[o]===0x42 && b[o+1]===0x4D) return 'image/bmp';
    if (b[o]===0x52 && b[o+1]===0x49 && b[o+2]===0x46 && b[o+3]===0x46 &&
        o+11 < b.length &&
        b[o+8]===0x57 && b[o+9]===0x45 && b[o+10]===0x42 && b[o+11]===0x50) return 'image/webp';
    return 'image/jpeg';
  }

  /* ═══════════════════════════════════════════════════════════
     METADATA RESULT TEMPLATE
  ══════════════════════════════════════════════════════════ */
  function _blankMeta(filename) {
    const base = (filename||'').replace(/\.[^.]+$/, '');
    const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
    return {
      title:           dash ? dash[2].trim() : base,
      artist:          dash ? dash[1].trim() : '',
      releaseDate:     null,
      thumbData:       null,   // ArrayBuffer: サムネイル（Front Cover）
      thumbMime:       null,
      artistIconData:  null,   // ArrayBuffer: アーティストアイコン（Artist type or Icon type）
      artistIconMime:  null,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     ID3v2 PARSER  (MP3)
     BUG FIX: TDRC / TDRL の完全日付保持（YYYY-MM-DD）
     BUG FIX: APIC を picture type で分類
       type 3 (Front Cover) → thumbData
       type 1 / 2 / 8       → artistIconData
       それ以外              → thumbData がなければ使用
  ══════════════════════════════════════════════════════════ */
  function _parseID3(bytes, result) {
    if (bytes.length < 10) return false;
    if (!(bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33)) return false;
    const major = bytes[3];
    if (major < 2 || major > 4) return false;

    const extHeader = (bytes[5] & 0x40) !== 0;
    const tagSize = ((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|
                    ((bytes[8]&0x7F)<<7) | (bytes[9]&0x7F);
    let off = 10;

    if (extHeader && major === 4) {
      const extSize = ((bytes[off]&0x7F)<<21)|((bytes[off+1]&0x7F)<<14)|
                      ((bytes[off+2]&0x7F)<<7) | (bytes[off+3]&0x7F);
      off += extSize;
    } else if (extHeader && major === 3) {
      const extSize = _u32be(bytes, off);
      off += 4 + extSize;
    }

    const end = Math.min(10 + tagSize, bytes.length);

    while (off + (major === 2 ? 6 : 10) < end) {
      let fid, fsz;
      if (major === 2) {
        fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2]);
        fsz = (bytes[off+3]<<16)|(bytes[off+4]<<8)|bytes[off+5];
        off += 6;
      } else {
        fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
        fsz = (major === 4)
          ? ((bytes[off+4]&0x7F)<<21)|((bytes[off+5]&0x7F)<<14)|
            ((bytes[off+6]&0x7F)<<7) | (bytes[off+7]&0x7F)
          : _u32be(bytes, off+4);
        off += 10;
      }

      if (fid === '\0\0\0\0' || fid === '\0\0\0') break;
      if (fsz <= 0 || off + fsz > end) break;

      const fd = bytes.subarray(off, off + fsz);
      const id = major === 2
        ? ({ TT2:'TIT2', TP1:'TPE1', TYE:'TYER', TDA:'TDRC', PIC:'APIC' }[fid] || fid)
        : fid;

      switch (id) {
        case 'TIT2': { const v=_id3Text(fd); if(v) result.title   = v; break; }
        case 'TPE1': { const v=_id3Text(fd); if(v) result.artist  = v; break; }
        case 'TALB': break;
        /* BUG FIX: TDRC / TDRL / TYER — YYYY-MM-DD の完全日付を保持 */
        case 'TDRC':
        case 'TDRL':
        case 'TYER': {
          const v = _id3Text(fd);
          if (v && /^\d{4}/.test(v)) {
            // YYYY-MM-DD の形式なら完全日付を使用、それ以外は YYYY-01-01 にフォールバック
            const fullDate = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
            result.releaseDate = fullDate ? fullDate[0] : v.slice(0,4) + '-01-01';
          }
          break;
        }
        /* BUG FIX: APIC を picture type で分類 */
        case 'APIC': {
          const pic = _id3APIC(fd);
          if (pic) {
            const picType = pic.picType;
            if (picType === 3) {
              // Front Cover → サムネイル（優先）
              if (!result.thumbData) {
                result.thumbData = pic.data;
                result.thumbMime = pic.mime;
              }
            } else if (picType === 1 || picType === 2 || picType === 8) {
              // Icon (1,2) / Artist (8) → アーティストアイコン（優先）
              if (!result.artistIconData) {
                result.artistIconData = pic.data;
                result.artistIconMime = pic.mime;
              }
            } else {
              // その他: サムネイルが未設定なら使用
              if (!result.thumbData) {
                result.thumbData = pic.data;
                result.thumbMime = pic.mime;
              }
            }
          }
          break;
        }
        /* ID3v2.2 PIC フレーム */
        case 'PIC': {
          if (fd.length > 5) {
            let p = 1;
            const fmt = String.fromCharCode(fd[p],fd[p+1],fd[p+2]); p+=3;
            const picType = fd[p]; p++;
            while (p < fd.length && fd[p] !== 0) p++; p++;
            if (p < fd.length && !result.thumbData) {
              const imgData = fd.slice(p);
              result.thumbData = imgData.buffer;
              result.thumbMime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
            }
          }
          break;
        }
      }
      off += fsz;
    }
    return true;
  }

  function _id3Text(data) {
    if (!data || data.length === 0) return '';
    const enc = data[0];
    const raw = data.subarray(1);
    try {
      let s;
      if (enc === 1 || enc === 2) s = new TextDecoder('utf-16').decode(raw);
      else if (enc === 3)          s = new TextDecoder('utf-8').decode(raw);
      else                         s = new TextDecoder('latin1').decode(raw);
      return s.replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  /**
   * BUG FIX: picType を返すように拡張
   * @returns {{ data, mime, picType }} | null
   */
  function _id3APIC(data) {
    if (!data || data.length < 6) return null;
    const enc = data[0];
    let pos = 1;

    const mimeStart = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    const mimeStr = new TextDecoder('latin1').decode(data.slice(mimeStart, pos));
    if (pos >= data.length) return null;
    pos++;

    const picType = data[pos];  // picture type byte
    pos++;

    // Description
    if (enc === 1 || enc === 2) {
      if (pos % 2 !== 0) pos++;
      while (pos + 1 < data.length) {
        if (data[pos] === 0 && data[pos+1] === 0) { pos += 2; break; }
        pos += 2;
      }
    } else {
      while (pos < data.length && data[pos] !== 0) pos++;
      if (pos < data.length) pos++;
    }

    if (pos >= data.length) return null;
    const imgData = data.slice(pos);
    if (imgData.length < 4) return null;

    const realMime = _imgMime(imgData);
    return { data: imgData.buffer, mime: realMime, picType };
  }

  /* ═══════════════════════════════════════════════════════════
     M4A / MP4 ATOM PARSER
  ══════════════════════════════════════════════════════════ */
  function _parseM4A(bytes, result) {
    if (bytes.length < 8) return false;
    const firstAtom = String.fromCharCode(bytes[4],bytes[5],bytes[6],bytes[7]);
    if (firstAtom !== 'ftyp' && firstAtom !== 'moov' && firstAtom !== 'free') return false;

    const moov = _findAtom(bytes, 0, bytes.length, 'moov');
    if (!moov) return false;

    const udta = _findAtom(bytes, moov.data, moov.end, 'udta');
    if (!udta) return _tryM4AAlternate(bytes, moov, result);

    const meta = _findAtom(bytes, udta.data, udta.end, 'meta');
    if (!meta) return false;

    const ilstOff = meta.data + 4;
    const ilst = _findAtom(bytes, ilstOff, meta.end, 'ilst');
    if (!ilst) return false;

    let off = ilst.data;
    while (off + 8 < ilst.end) {
      const aSize = _u32be(bytes, off);
      if (aSize < 8 || off + aSize > ilst.end) break;
      const aType = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);

      const dataAtom = _findAtom(bytes, off+8, off+aSize, 'data');
      if (dataAtom && dataAtom.end - dataAtom.data > 8) {
        const payload = bytes.subarray(dataAtom.data + 8, dataAtom.end);
        if (aType === 'covr') {
          if (!result.thumbData && payload.length > 4) {
            result.thumbData = payload.slice(0).buffer;
            result.thumbMime = _imgMime(payload);
          }
        } else {
          try {
            const text = new TextDecoder('utf-8').decode(payload).trim();
            if (aType === '\xa9nam' && text) result.title       = text;
            if (aType === '\xa9ART' && text) result.artist      = text;
            if (aType === '\xa9day' && text && /^\d{4}/.test(text)) {
              // BUG FIX: 完全日付を保持
              const fullDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
              result.releaseDate = fullDate ? fullDate[0] : text.slice(0,4) + '-01-01';
            }
          } catch {}
        }
      }
      off += aSize;
    }
    return true;
  }

  function _tryM4AAlternate(bytes, moov, result) {
    const ilst = _findAtomDeep(bytes, moov.data, moov.end, ['ilst']);
    if (!ilst) return false;
    let off = ilst.data;
    while (off + 8 < ilst.end) {
      const aSize = _u32be(bytes, off);
      if (aSize < 8 || off + aSize > ilst.end) break;
      const dataAtom = _findAtom(bytes, off+8, off+aSize, 'data');
      if (dataAtom && dataAtom.end - dataAtom.data > 8) {
        const aType = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);
        const payload = bytes.subarray(dataAtom.data + 8, dataAtom.end);
        if (aType === 'covr' && !result.thumbData && payload.length > 4) {
          result.thumbData = payload.slice(0).buffer;
          result.thumbMime = _imgMime(payload);
        }
      }
      off += aSize;
    }
    return !!result.thumbData;
  }

  function _findAtom(bytes, start, end, name) {
    let off = start;
    while (off + 8 <= end) {
      let size = _u32be(bytes, off);
      if (size === 1) {
        if (off + 16 > end) break;
        size = Number(
          (BigInt(bytes[off+8])<<56n)|(BigInt(bytes[off+9])<<48n)|
          (BigInt(bytes[off+10])<<40n)|(BigInt(bytes[off+11])<<32n)|
          (BigInt(bytes[off+12])<<24n)|(BigInt(bytes[off+13])<<16n)|
          (BigInt(bytes[off+14])<<8n)|BigInt(bytes[off+15])
        );
      } else if (size === 0) {
        size = end - off;
      }
      if (size < 8) break;
      const type = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);
      if (type === name) return { start:off, end:off+size, data:off+8 };
      off += size;
    }
    return null;
  }

  function _findAtomDeep(bytes, start, end, path) {
    let cur = { start, end, data:start };
    for (const name of path) {
      const next = _findAtom(bytes, cur.data, cur.end, name);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /* ═══════════════════════════════════════════════════════════
     FLAC PARSER
  ══════════════════════════════════════════════════════════ */
  function _parseFLAC(bytes, result) {
    if (!(bytes[0]===0x66 && bytes[1]===0x4C && bytes[2]===0x61 && bytes[3]===0x43)) return false;
    let off = 4;
    let isLast = false;
    while (!isLast && off + 4 <= bytes.length) {
      const header = bytes[off];
      isLast = (header & 0x80) !== 0;
      const bType = header & 0x7F;
      const bLen  = (bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3];
      off += 4;
      if (off + bLen > bytes.length) break;
      if (bType === 6) {
        const pic = _parseFLACPicture(bytes, off, bLen);
        if (pic && !result.thumbData) { result.thumbData = pic.data; result.thumbMime = pic.mime; }
      } else if (bType === 4) {
        _parseVorbisComment(bytes, off, off + bLen, result);
      }
      off += bLen;
    }
    return true;
  }

  function _parseFLACPicture(bytes, start, len) {
    let off = start;
    const end = start + len;
    if (off + 8 > end) return null;
    off += 4; // picType
    const mimeLen = _u32be(bytes, off); off += 4;
    if (off + mimeLen > end) return null;
    const mime = new TextDecoder('latin1').decode(bytes.subarray(off, off+mimeLen));
    off += mimeLen;
    if (off + 4 > end) return null;
    const descLen = _u32be(bytes, off); off += 4;
    off += descLen;
    off += 16; // width, height, colorDepth, colorCount
    if (off + 4 > end) return null;
    const dataLen = _u32be(bytes, off); off += 4;
    if (dataLen === 0 || off + dataLen > end) return null;
    const imgData = bytes.slice(off, off + dataLen);
    return { data: imgData.buffer, mime: mime || _imgMime(imgData) };
  }

  /* ═══════════════════════════════════════════════════════════
     OGG VORBIS PARSER
  ══════════════════════════════════════════════════════════ */
  function _parseOGG(bytes, result) {
    if (!(bytes[0]===0x4F && bytes[1]===0x67 && bytes[2]===0x67 && bytes[3]===0x53)) return false;
    const packets = _oggCollectPackets(bytes, 4);
    for (const pkt of packets) {
      if (pkt.length > 7 &&
          pkt[0]===0x03 && pkt[1]===0x76 && pkt[2]===0x6F &&
          pkt[3]===0x72 && pkt[4]===0x62 && pkt[5]===0x69 && pkt[6]===0x73) {
        _parseVorbisComment(pkt, 7, pkt.length, result); return true;
      }
      if (pkt.length > 8 &&
          pkt[0]===0x4F && pkt[1]===0x70 && pkt[2]===0x75 && pkt[3]===0x73 &&
          pkt[4]===0x54 && pkt[5]===0x61 && pkt[6]===0x67 && pkt[7]===0x73) {
        _parseVorbisComment(pkt, 8, pkt.length, result); return true;
      }
    }
    return false;
  }

  function _oggCollectPackets(bytes, maxPages) {
    const packets = [];
    let off = 0, pages = 0;
    while (off + 27 <= bytes.length && pages < maxPages) {
      if (!(bytes[off]===0x4F && bytes[off+1]===0x67 && bytes[off+2]===0x67 && bytes[off+3]===0x53)) break;
      const numSegs = bytes[off+26];
      if (off + 27 + numSegs > bytes.length) break;
      let pageDataLen = 0;
      for (let i = 0; i < numSegs; i++) pageDataLen += bytes[off + 27 + i];
      const dataStart = off + 27 + numSegs;
      if (dataStart + pageDataLen > bytes.length) break;
      packets.push(bytes.subarray(dataStart, dataStart + pageDataLen));
      off = dataStart + pageDataLen;
      pages++;
    }
    return packets;
  }

  function _parseVorbisComment(bytes, start, end, result) {
    let off = start;
    if (off + 4 > end) return;
    const vendorLen = _u32le(bytes, off); off += 4;
    off += vendorLen;
    if (off + 4 > end) return;
    const count = _u32le(bytes, off); off += 4;
    for (let i = 0; i < count && off + 4 <= end; i++) {
      const len = _u32le(bytes, off); off += 4;
      if (off + len > end) break;
      const comment = new TextDecoder('utf-8').decode(bytes.subarray(off, off+len));
      off += len;
      const eq = comment.indexOf('=');
      if (eq < 0) continue;
      const key = comment.slice(0, eq).toUpperCase();
      const val = comment.slice(eq + 1).trim();
      if (key === 'TITLE'  && val && !result.title)  result.title  = val;
      if (key === 'ARTIST' && val && !result.artist) result.artist = val;
      if (key === 'DATE'   && val && /^\d{4}/.test(val) && !result.releaseDate) {
        const fullDate = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
        result.releaseDate = fullDate ? fullDate[0] : val.slice(0,4) + '-01-01';
      }
      if ((key === 'METADATA_BLOCK_PICTURE' || key === 'COVERART') && !result.thumbData) {
        try {
          const b64 = val.replace(/[\r\n\s]/g,'');
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let j=0; j<bin.length; j++) buf[j] = bin.charCodeAt(j);
          if (key === 'COVERART') {
            result.thumbData = buf.buffer; result.thumbMime = _imgMime(buf);
          } else {
            const pic = _parseFLACPicture(buf, 0, buf.length);
            if (pic) { result.thumbData = pic.data; result.thumbMime = pic.mime; }
          }
        } catch {}
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     UNIFIED METADATA PARSER
  ══════════════════════════════════════════════════════════ */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = _blankMeta(filename);
    if (!buffer || buffer.byteLength < 8) return result;
    const bytes = new Uint8Array(buffer);
    if (_parseID3(bytes, result))  return result;
    if (_parseFLAC(bytes, result)) return result;
    if (_parseOGG(bytes, result))  return result;
    if (_parseM4A(bytes, result))  return result;
    return result;
  }

  /* ═══════════════════════════════════════════════════════════
     FILE META — reads from a File object
  ══════════════════════════════════════════════════════════ */
  async function readAudioMeta(file) {
    let meta = _blankMeta(file.name);

    try {
      const peek = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      let readSize = 512 * 1024;

      if (peek[0]===0x49 && peek[1]===0x44 && peek[2]===0x33 && peek[3] >= 3) {
        const tagSize = ((peek[6]&0x7F)<<21)|((peek[7]&0x7F)<<14)|
                        ((peek[8]&0x7F)<<7) | (peek[9]&0x7F);
        readSize = Math.min(tagSize + 10, 30 * 1024 * 1024);
      } else if (peek[0]===0x66 && peek[1]===0x4C && peek[2]===0x61 && peek[3]===0x43) {
        readSize = Math.min(file.size, 10 * 1024 * 1024);
      } else if (peek[0]===0x4F && peek[1]===0x67 && peek[2]===0x67 && peek[3]===0x53) {
        readSize = Math.min(file.size, 2 * 1024 * 1024);
      } else {
        readSize = Math.min(file.size, 8 * 1024 * 1024);
      }

      const buf = await file.slice(0, readSize).arrayBuffer();
      meta = parseAudioMetaFromBuffer(buf, file.name);

      if (!meta.thumbData && readSize < file.size &&
          !(peek[0]===0x49) && !(peek[0]===0x66) && !(peek[0]===0x4F)) {
        const tailSize = Math.min(4 * 1024 * 1024, file.size);
        const tail = await file.slice(file.size - tailSize).arrayBuffer();
        const tailMeta = parseAudioMetaFromBuffer(tail, file.name);
        if (tailMeta.thumbData) { meta.thumbData = tailMeta.thumbData; meta.thumbMime = tailMeta.thumbMime; }
        if (!meta.title  && tailMeta.title)  meta.title  = tailMeta.title;
        if (!meta.artist && tailMeta.artist) meta.artist = tailMeta.artist;
        if (!meta.releaseDate && tailMeta.releaseDate) meta.releaseDate = tailMeta.releaseDate;
      }
    } catch (e) {
      console.warn('[Storage] readAudioMeta error:', e);
    }

    const duration = await new Promise(resolve => {
      const a   = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.src = url; a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch{} resolve(0); }, 6000);
    });

    return { ...meta, duration };
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */
  return {
    open, uid,
    getTracks, getTrack, addTrack, updateTrack, deleteTrack, reorderTracks,
    saveBlob, getBlob, deleteBlob, getBlobUrl, getAudioBlobUrl,
    getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist,
    getTags, getTag, createTag, updateTag, deleteTag, reorderTags,
    getArtists, getArtist, getArtistByName, getOrCreateArtist,
    createArtist, updateArtist, deleteArtist, reorderArtists,
    getLogs, addLog, addLogRaw,
    getMeta, setMeta, deleteMeta,
    exportSnapshot, importSnapshot,
    resetAll,
    readAudioMeta,
    parseAudioMetaFromBuffer,
  };
})();
