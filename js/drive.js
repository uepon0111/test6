/**
 * drive.js — Google Drive integration for Sonora
 *
 * BUG FIXES / NEW FEATURES:
 *  1. 1アカウント1端末制限:
 *     - ログイン時に Drive の sonora_device.json を確認し、
 *       別端末が既に連携済みの場合はログインを拒否する
 *  2. アカウント連携解除 (disconnectAccount):
 *     - ページキャッシュ (IndexedDB) 削除
 *     - Drive 内の Sonora フォルダ削除
 *     - アカウント連携情報削除
 *  3. _deleteFile を _api 経由に変更して 401 ハンドリングを統一
 *  4. _diffAudio で同一ベース名の重複 Drive ファイルを検出・削除
 *  5. 同期中断チェックポイント
 */

const Drive = (() => {

  /* ─── CONFIG ─── */
  const CLIENT_ID   = '216604412012-80eanap7n3ldoa1npd73v22t9gl552nq.apps.googleusercontent.com';
  const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';
  const LOGS_FILE   = 'sonora_logs.json';
  const DEVICE_FILE = 'sonora_device.json';   // 端末制限用ファイル
  const SYNC_CHECKPOINT_KEY = 'syncCheckpoint';

  /* ─── STATE ─── */
  let _token       = null;
  let _userEmail   = null;
  let _tokenClient = null;
  let _autoSync    = false;
  let _syncBusy    = false;
  let _autoTimer   = null;
  let _debounce    = null;
  let _logTimer    = null;

  let _fid   = null;
  let _afid  = null;
  let _tfid  = null;
  let _lfid  = null;

  const _uploadingIds = new Set();

  /* ─── PROGRESS ─── */
  function _prog(pct, detail) {
    const wrap  = document.getElementById('sync-progress-wrap');
    const fill  = document.getElementById('sync-bar-fill');
    const det   = document.getElementById('sync-detail-txt');
    const pctEl = document.getElementById('sync-pct-txt');
    if (wrap)  wrap.classList.add('visible');
    if (fill)  fill.style.width = Math.min(100, pct) + '%';
    if (det)   det.textContent  = detail;
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  }
  function _progDone() {
    setTimeout(() => {
      const w = document.getElementById('sync-progress-wrap');
      const f = document.getElementById('sync-bar-fill');
      if (w) w.classList.remove('visible');
      if (f) f.style.width = '0%';
    }, 2000);
  }

  /* ─── PARALLEL RUNNER ─── */
  async function _parallel(items, fn, limit = 3) {
    if (!items.length) return;
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try { await fn(item); } catch (e) { console.warn('[Drive] parallel task err:', e); }
        }
      })
    );
  }

  /* ─── SYNC CHECKPOINT ─── */
  async function _saveCheckpoint(phase) {
    await Storage.setMeta(SYNC_CHECKPOINT_KEY, { phase, time: Date.now() }).catch(() => {});
  }
  async function _clearCheckpoint() {
    await Storage.deleteMeta(SYNC_CHECKPOINT_KEY).catch(() => {});
  }

  /* ═══════════════════════════════════════════════════════════
     DEVICE MANAGEMENT — 1アカウント1端末制限
  ══════════════════════════════════════════════════════════ */

  /**
   * この端末固有の ID を IndexedDB から取得（なければ新規生成）
   */
  async function _getDeviceId() {
    let id = await Storage.getMeta('deviceId');
    if (!id) {
      id = Storage.uid() + '-' + Date.now().toString(36);
      await Storage.setMeta('deviceId', id);
    }
    return id;
  }

  /**
   * Drive 上の sonora_device.json を読み取り、
   * この端末がログインを許可されているか確認する。
   * @returns {{ allowed: boolean, registeredDeviceId: string|null }}
   */
  async function _checkDevice() {
    try {
      await _folders();
    } catch {
      // フォルダが存在しない = 新規アカウント → 許可
      return { allowed: true, registeredDeviceId: null };
    }

    const dfId = await _findDeviceFileId();
    if (!dfId) return { allowed: true, registeredDeviceId: null };

    try {
      const buf = await _download(dfId);
      const data = JSON.parse(new TextDecoder().decode(buf));
      const currentId = await _getDeviceId();
      if (data.deviceId && data.deviceId !== currentId) {
        return { allowed: false, registeredDeviceId: data.deviceId };
      }
      return { allowed: true, registeredDeviceId: data.deviceId };
    } catch {
      return { allowed: true, registeredDeviceId: null };
    }
  }

  /**
   * この端末を Drive に登録する（ログイン成功後に呼ぶ）
   */
  async function _registerDevice() {
    try {
      await _folders();
      const deviceId = await _getDeviceId();
      const blob = new Blob(
        [JSON.stringify({ deviceId, registeredAt: Date.now(), email: _userEmail })],
        { type: 'application/json' }
      );
      const existing = await _findDeviceFileId();
      const r = await _upload(DEVICE_FILE, 'application/json', blob, _fid, existing);
      if (r?.id) await Storage.setMeta('driveDeviceFileId', r.id);
    } catch (e) {
      console.warn('[Drive] _registerDevice failed:', e);
    }
  }

  async function _findDeviceFileId() {
    let id = await Storage.getMeta('driveDeviceFileId');
    if (!id) {
      await _folders();
      const r = await _list({
        q: `name='${DEVICE_FILE}' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      }).catch(() => ({ files: [] }));
      id = r.files?.[0]?.id || null;
      if (id) await Storage.setMeta('driveDeviceFileId', id);
    }
    return id || null;
  }

  /**
   * Drive から端末登録を削除する（連携解除時）
   */
  async function _unregisterDevice() {
    try {
      const dfId = await Storage.getMeta('driveDeviceFileId');
      if (dfId) await _deleteFile(dfId);
    } catch {}
    await Storage.deleteMeta('driveDeviceFileId').catch(() => {});
  }

  /* ═══════════════════════════════════════════════════════════
     AUTH
  ══════════════════════════════════════════════════════════ */
  function init() {
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2) {
        clearInterval(check);
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope:     SCOPES,
          callback:  _onToken,
        });
      }
    }, 300);

    Storage.getMeta('driveToken').then(tok => {
      if (tok?.expiry > Date.now()) {
        _token     = tok.token;
        _userEmail = tok.email || null;
        _updateLoginUI(true);
      }
    });

    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const t = document.getElementById('auto-sync-toggle');
      if (t && v) t.classList.add('on');
      if (v && _token) _scheduleAuto();
    });
  }

  async function _onToken(resp) {
    if (resp.error) { UI?.toast('Googleログインに失敗しました', 'error'); return; }
    _token = resp.access_token;
    const expiry = Date.now() + (resp.expires_in - 60) * 1000;

    // ユーザー情報を取得
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: 'Bearer ' + _token } });
      const d = await r.json();
      _userEmail = d.email || null;
    } catch {}

    /* ─── ページ内アカウント 1:1 連携チェック ───────────────────────────
       一度このページに連携したGoogleアカウントと異なるアカウントでの
       ログインを拒否する。連携解除 (disconnectAccount) 後のみ変更可能。
    ──────────────────────────────────────────────────────────────── */
    const linkedEmail = await Storage.getMeta('linkedGoogleEmail');
    if (linkedEmail && _userEmail && linkedEmail !== _userEmail) {
      UI?.toast(
        `このページは「${linkedEmail}」と連携済みです。\n別のアカウントでログインするには、先に設定から「連携解除」してください。`,
        'error'
      );
      console.warn('[Drive] Account mismatch. Linked:', linkedEmail, 'Attempted:', _userEmail);
      _token     = null;
      _userEmail = null;
      return;
    }

    /* ─── 1端末制限チェック（別端末での使用禁止） ─── */
    const { allowed, registeredDeviceId } = await _checkDevice();
    if (!allowed) {
      UI?.toast(
        'このアカウントは別の端末で既に連携されています。\n連携するには、先に別の端末で「連携解除」してください。',
        'error'
      );
      console.warn('[Drive] Device check failed. Registered device:', registeredDeviceId);
      _token     = null;
      _userEmail = null;
      return;
    }

    // 端末を登録・保存
    await _registerDevice();
    // ページ内アカウント連携メールを保存（初回 or 同一アカウント再ログイン）
    if (_userEmail) await Storage.setMeta('linkedGoogleEmail', _userEmail);
    await Storage.setMeta('driveToken', { token: _token, expiry, email: _userEmail });
    _updateLoginUI(true);
    UI?.toast('Googleアカウントでログインしました');

    if (_autoSync) syncNow();
  }

  function toggleLogin() { _token ? _logout() : _login(); }

  function _login() {
    if (!_tokenClient) { UI?.toast('Google認証の読み込み中です', 'error'); return; }
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function _logout() {
    if (_token && typeof google !== 'undefined')
      google.accounts.oauth2.revoke(_token, () => {});
    _token = null; _userEmail = null;
    _fid = null; _afid = null; _tfid = null;
    _uploadingIds.clear();
    clearTimeout(_autoTimer);
    Storage.deleteMeta('driveToken');
    Storage.deleteMeta('driveFolderId');
    Storage.deleteMeta('driveAudioFolderId');
    Storage.deleteMeta('driveThumbFolderId');
    Storage.deleteMeta('driveIndexFileId');
    Storage.deleteMeta('driveDeviceFileId');
    _updateLoginUI(false);
    UI?.toast('ログアウトしました');
  }

  /**
   * アカウント連携解除:
   *   1. Drive の端末登録ファイルを削除
   *   2. Drive の Sonora フォルダを削除
   *   3. ローカルキャッシュ (IndexedDB) を全削除
   *   4. ページリロード
   */
  async function disconnectAccount() {
    if (!_token) {
      UI?.toast('ログインしていません', 'error');
      return;
    }

    UI?.toast('連携解除中...');
    try {
      // 1. 端末登録を削除
      await _unregisterDevice();

      // 2. Drive フォルダを削除（全データを削除）
      await resetDriveData();

      // 3. ログアウト処理（Drive 側トークン失効）
      if (_token && typeof google !== 'undefined')
        google.accounts.oauth2.revoke(_token, () => {});

      // 4. ローカル IndexedDB を全削除
      await Storage.resetAll();

      UI?.toast('連携解除が完了しました。ページをリロードします...', 'success');
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      console.error('[Drive] disconnectAccount error:', err);
      // エラーでもローカルデータだけ消してリロード
      try { await Storage.resetAll(); } catch {}
      setTimeout(() => location.reload(), 1500);
    }
  }

  const isLoggedIn = () => !!_token;

  function _updateLoginUI(on) {
    const txt        = document.getElementById('settings-login-txt');
    const row        = document.getElementById('account-info-row');
    const mail       = document.getElementById('account-email');
    const sbtn       = document.getElementById('sync-now-btn');
    const discBtn    = document.getElementById('disconnect-btn');   // 連携解除ボタン
    if (txt)     txt.textContent   = on ? 'ログアウト' : 'ログイン';
    if (row)     row.style.display = on ? 'flex' : 'none';
    if (mail && _userEmail) mail.textContent = _userEmail;
    if (sbtn)    sbtn.disabled = !on;
    if (discBtn) discBtn.style.display = on ? '' : 'none';
    const discRow = document.getElementById('disconnect-btn-row');
    if (discRow) discRow.style.display = on ? '' : 'none';
  }

  /* ─── AUTO SYNC ─── */
  function toggleAutoSync(btn) {
    _autoSync = !_autoSync;
    btn.classList.toggle('on', _autoSync);
    Storage.setMeta('autoSync', _autoSync);
    if (_autoSync && _token) _scheduleAuto();
    else clearTimeout(_autoTimer);
    UI?.toast(_autoSync ? '自動同期オン' : '自動同期オフ');
  }
  function _scheduleAuto() {
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(() => {
      if (_autoSync && _token) syncNow().then(_scheduleAuto);
    }, 5 * 60 * 1000);
  }
  function triggerAutoSync() {
    if (!_autoSync || !_token) return;
    clearTimeout(_debounce);
    _debounce = setTimeout(() => syncNow(), 4000);
  }
  function scheduleSyncLogs() {
    clearTimeout(_logTimer);
    _logTimer = setTimeout(async () => {
      if (!_token) return;
      try {
        await _folders();
        await _pullAndMergeLogs();
        await _pushLogs();
      } catch (e) {
        console.warn('[Drive] scheduleSyncLogs error:', e);
        _pushIndex().catch(() => {});
      }
    }, 10000);
  }

  /* ─── DRIVE API ─── */
  async function _api(method, url, body, ct) {
    if (!_token) throw new Error('Not authenticated');
    const headers = { Authorization: 'Bearer ' + _token };
    if (ct) headers['Content-Type'] = ct;
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401) {
      _token = null;
      Storage.deleteMeta('driveToken');
      _updateLoginUI(false);
      throw new Error('Token expired');
    }
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Drive ${res.status}: ` + await res.text());
    const ctype = res.headers.get('content-type') || '';
    return ctype.includes('application/json') ? res.json() : res.arrayBuffer();
  }

  async function _list(params) {
    const qs = new URLSearchParams(params).toString();
    return _api('GET', `https://www.googleapis.com/drive/v3/files?${qs}`);
  }
  async function _createFolder(name, parentId) {
    return _api('POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] }),
      'application/json');
  }
  async function _upload(name, mime, data, parentId, existingId) {
    const metaObj = { name, parents: existingId ? undefined : (parentId ? [parentId] : []) };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metaObj)], { type: 'application/json' }));
    form.append('file', data instanceof Blob ? data : new Blob([data], { type: mime }), name);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    return _api(existingId ? 'PATCH' : 'POST', url, form);
  }
  const _download = id =>
    _api('GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);

  async function _deleteFile(id) {
    if (!_token || !id) return;
    try {
      await _api('DELETE', `https://www.googleapis.com/drive/v3/files/${id}`);
    } catch (e) {
      if (!e.message?.includes('Drive 404')) {
        console.warn('[Drive] _deleteFile failed:', id, e.message);
      }
    }
  }

  /* ─── FOLDER SETUP ─── */
  async function _folders() {
    if (!_fid) _fid = await Storage.getMeta('driveFolderId');
    if (!_fid) {
      const r = await _list({
        q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      });
      _fid = r.files?.[0]?.id || (await _createFolder(FOLDER_NAME)).id;
      await Storage.setMeta('driveFolderId', _fid);
    }
    const [af, tf] = await Promise.all([
      _ensureSubFolder('audio',  'driveAudioFolderId', _afid),
      _ensureSubFolder('thumbs', 'driveThumbFolderId', _tfid),
    ]);
    _afid = af; _tfid = tf;
  }
  async function _ensureSubFolder(name, metaKey, cached) {
    if (cached) return cached;
    let id = await Storage.getMeta(metaKey);
    if (!id) {
      const r = await _list({
        q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      id = r.files?.[0]?.id || (await _createFolder(name, _fid)).id;
      await Storage.setMeta(metaKey, id);
    }
    return id;
  }

  /* ─── INDEX ─── */
  async function _indexFileId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (!id) {
      const r = await _list({
        q: `name='${INDEX_FILE}' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveIndexFileId', id); }
    }
    return id || null;
  }
  async function _pushIndex() {
    await _folders();
    const snap       = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snap.deletedIds  = deletedIds;
    const blob       = new Blob([JSON.stringify(snap)], { type: 'application/json' });
    const existing   = await _indexFileId();
    const r = await _upload(INDEX_FILE, 'application/json', blob, _fid, existing);
    if (r?.id) await Storage.setMeta('driveIndexFileId', r.id);
  }
  async function _pullIndex() {
    const id = await _indexFileId();
    if (!id) return null;
    try {
      const buf = await _download(id);
      return JSON.parse(new TextDecoder().decode(buf));
    } catch { return null; }
  }

  /* ─── LOGS FILE ─── */
  async function _logsFileId() {
    if (_lfid) return _lfid;
    let id = await Storage.getMeta('driveLogsFileId');
    if (!id) {
      await _folders();
      const r = await _list({
        q: `name='${LOGS_FILE}' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveLogsFileId', id); }
    }
    _lfid = id || null;
    return _lfid;
  }

  async function _pushLogs() {
    await _folders();
    const logs = await Storage.getLogs();
    const blob = new Blob([JSON.stringify({ version: 1, logs })], { type: 'application/json' });
    const existing = await _logsFileId();
    const r = await _upload(LOGS_FILE, 'application/json', blob, _fid, existing);
    if (r?.id) { _lfid = r.id; await Storage.setMeta('driveLogsFileId', r.id); }
  }

  async function _pullAndMergeLogs() {
    const id = await _logsFileId();
    if (!id) return;
    try {
      const buf    = await _download(id);
      const remote = JSON.parse(new TextDecoder().decode(buf));
      const localLogs = await Storage.getLogs();
      const exIds  = new Set(localLogs.map(l => l.id));
      let added = 0;
      for (const log of remote.logs || []) {
        if (!exIds.has(log.id)) {
          await Storage.addLogRaw(log);
          exIds.add(log.id);
          added++;
        }
      }
      if (added > 0) console.log(`[Drive] Merged ${added} remote log entries`);
    } catch (e) {
      console.warn('[Drive] _pullAndMergeLogs error:', e);
    }
  }

  /* ─── AUDIO / THUMB TRANSFER ─── */
  async function _uploadAudio(track) {
    if (!track.blobKey) return;
    const lockKey = 'audio:' + track.id;
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      const buf = await Storage.getBlob(fresh.blobKey);
      if (!buf) return;
      const r = await _upload(fresh.id + '.mp3', 'audio/mpeg', buf, _afid, fresh.driveFileId || null);
      if (r?.id) await Storage.updateTrack(fresh.id, { driveFileId: r.id });
    } finally {
      _uploadingIds.delete(lockKey);
    }
  }
  async function _uploadThumb(track) {
    if (!track.thumbKey) return;
    const lockKey = 'thumb:' + track.id;
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      const buf = await Storage.getBlob(fresh.thumbKey);
      if (!buf) return;
      const r = await _upload(fresh.id + '.jpg', 'image/jpeg', buf, _tfid, fresh.driveThumbId || null);
      if (r?.id) await Storage.updateTrack(fresh.id, { driveThumbId: r.id });
    } finally {
      _uploadingIds.delete(lockKey);
    }
  }
  async function _downloadAudio(track) {
    if (!track.driveFileId) return false;
    try {
      const buf = await _download(track.driveFileId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { blobKey: key });
      return true;
    } catch { return false; }
  }
  async function _downloadThumb(track) {
    if (!track.driveThumbId) return false;
    try {
      const buf = await _download(track.driveThumbId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { thumbKey: key });
      return true;
    } catch { return false; }
  }

  /* ─── EXTRACT METADATA FROM DRIVE FILE ─── */
  async function _extractMeta(driveFileId, fileName) {
    const fallback = () => {
      const base = (fileName || '').replace(/\.[^.]+$/, '');
      const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
      return { title: dash ? dash[2].trim() : base, artist: dash ? dash[1].trim() : '', duration: 0, releaseDate: null, thumbData: null, thumbMime: null, rawBuffer: null };
    };
    try {
      const raw = await _download(driveFileId);
      if (!raw) return fallback();
      const meta = Storage.parseAudioMetaFromBuffer(raw, fileName);
      const blob = new Blob([raw]);
      const url  = URL.createObjectURL(blob);
      const dur  = await new Promise(resolve => {
        const a = document.createElement('audio');
        a.src = url; a.preload = 'metadata';
        a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
        a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
        setTimeout(() => { URL.revokeObjectURL(url); resolve(0); }, 8000);
      });
      return { ...meta, duration: dur, rawBuffer: raw };
    } catch { return fallback(); }
  }

  /* ─── DIFF AUDIO ─── */
  async function _diffAudio(localTracks, deletedIds) {
    const r = await _list({
      q:        `'${_afid}' in parents and trashed=false`,
      fields:   'files(id,name,modifiedTime)',
      pageSize: 1000,
    }).catch(() => ({ files: [] }));

    const driveFiles     = r.files || [];
    const driveIdSet     = new Set(driveFiles.map(f => f.id));
    const localByDriveId = new Map(
      localTracks.filter(t => t.driveFileId).map(t => [t.driveFileId, t])
    );

    const toAdd    = [];
    const toDelete = [];
    const handledBases = new Set();

    for (const df of driveFiles) {
      const base = df.name.replace(/\.[^.]+$/, '');
      if (deletedIds.has(base) || deletedIds.has(df.id)) { toDelete.push(df.id); continue; }
      if (localByDriveId.has(df.id)) { handledBases.add(base); continue; }
      const matchByBase = localTracks.find(t => t.id === base);
      if (matchByBase) {
        if (!matchByBase.driveFileId) await Storage.updateTrack(matchByBase.id, { driveFileId: df.id });
        if (handledBases.has(base)) { toDelete.push(df.id); }
        else { handledBases.add(base); }
        continue;
      }
      if (!handledBases.has(base)) { toAdd.push(df); handledBases.add(base); }
      else { toDelete.push(df.id); }
    }

    const driveDeleted = localTracks.filter(
      t => t.driveFileId && !driveIdSet.has(t.driveFileId)
    );

    return { toAdd, toDelete, driveDeleted };
  }

  /* ─── MAIN SYNC ─── */
  async function syncNow() {
    if (!_token)   { UI?.toast('ログインしてから同期してください', 'error'); return; }
    if (_syncBusy) return;
    _syncBusy = true;

    try {
      const prevCp = await Storage.getMeta(SYNC_CHECKPOINT_KEY);
      if (prevCp) {
        const minsSince = Math.round((Date.now() - prevCp.time) / 60000);
        console.warn(`[Drive] 前回同期が '${prevCp.phase}' で中断 (${minsSince}分前)。再同期します。`);
        UI?.toast('前回の同期が中断されました。再同期します...', '');
      }

      _prog(5, 'フォルダを確認中...');
      await _saveCheckpoint('folders');
      await _folders();

      _prog(10, 'リモートデータを取得中...');
      await _saveCheckpoint('pull');
      const [remoteIndex, localTracks] = await Promise.all([_pullIndex(), Storage.getTracks()]);

      const deletedIds   = new Set(await Storage.getMeta('deletedTrackIds', []));
      const remoteDelIds = new Set(remoteIndex?.deletedIds || []);

      _prog(20, '差分を計算中...');
      await _saveCheckpoint('merge');
      for (const id of remoteDelIds) {
        const t = localTracks.find(t2 => t2.id === id);
        if (t && !deletedIds.has(id)) { await Storage.deleteTrack(id); deletedIds.add(id); }
      }
      if (remoteIndex) await Storage.importSnapshot(remoteIndex);

      _prog(30, 'Driveファイルを確認中...');
      await _saveCheckpoint('diff');
      const freshTracks = await Storage.getTracks();
      const { toAdd, toDelete, driveDeleted } = await _diffAudio(freshTracks, deletedIds);

      _prog(35, 'Driveからファイルを削除中...');
      await _saveCheckpoint('delete_drive');
      await _parallel(toDelete, id => _deleteFile(id), 3);

      for (const t of driveDeleted) { deletedIds.add(t.id); await Storage.deleteTrack(t.id); }

      _prog(40, 'ローカル削除を同期中...');
      await _saveCheckpoint('cleanup');
      for (const id of deletedIds) {
        const rt = remoteIndex?.tracks?.find(t => t.id === id);
        if (rt?.driveFileId)  await _deleteFile(rt.driveFileId).catch(() => {});
        if (rt?.driveThumbId) await _deleteFile(rt.driveThumbId).catch(() => {});
      }

      const afterMerge  = await Storage.getTracks();
      const needUpAudio = afterMerge.filter(t =>  t.blobKey  && !t.driveFileId);
      const needDlAudio = afterMerge.filter(t => !t.blobKey  &&  t.driveFileId);
      const needUpThumb = afterMerge.filter(t =>  t.thumbKey && !t.driveThumbId);
      const needDlThumb = afterMerge.filter(t => !t.thumbKey &&  t.driveThumbId);

      const totalIO = needUpAudio.length + needDlAudio.length + needUpThumb.length
                    + needDlThumb.length + toAdd.length;
      let doneIO = 0;
      const tick = () => { doneIO++; _prog(45 + (doneIO / Math.max(totalIO, 1)) * 40, '同期中...'); };

      _prog(45, 'ファイルを転送中...');
      await _saveCheckpoint('transfer');
      await Promise.all([
        _parallel(needUpAudio, async t => { await _uploadAudio(t);   tick(); }, 3),
        _parallel(needDlAudio, async t => { await _downloadAudio(t); tick(); }, 3),
        _parallel(needUpThumb, async t => { await _uploadThumb(t);   tick(); }, 3),
        _parallel(needDlThumb, async t => { await _downloadThumb(t); tick(); }, 2),
      ]);

      _prog(85, '新規ファイルを取り込み中...');
      await _saveCheckpoint('import');
      for (const df of toAdd) { await _importDriveFile(df); tick(); }

      _prog(88, 'ログを同期中...');
      await _saveCheckpoint('sync_logs');
      await _pullAndMergeLogs();
      await _pushLogs();

      _prog(93, 'インデックスを保存中...');
      await _saveCheckpoint('push_index');
      await _pushIndex();

      await Storage.setMeta('deletedTrackIds', [...deletedIds]);
      await _clearCheckpoint();

      _prog(100, '同期完了');
      _progDone();
      UI?.toast('同期が完了しました', 'success');
      if (typeof App !== 'undefined') App.refreshAll();

    } catch (err) {
      console.error('[Drive] Sync error:', err);
      _progDone();
      UI?.toast('同期エラー: ' + (err.message || '不明'), 'error');
    } finally {
      _syncBusy = false;
    }
  }

  /* ─── IMPORT A DRIVE-DIRECT FILE ─── */
  async function _importDriveFile(driveFile) {
    const meta = await _extractMeta(driveFile.id, driveFile.name);
    let blobKey  = null;
    let thumbKey = null;
    if (meta.rawBuffer) blobKey  = await Storage.saveBlob(meta.rawBuffer);
    if (meta.thumbData) thumbKey = await Storage.saveBlob(meta.thumbData);
    const base    = driveFile.name.replace(/\.[^.]+$/, '');
    const isOurId = /^[a-z0-9]{9,}$/.test(base);
    await Storage.addTrack({
      id:          isOurId ? base : undefined,
      title:       meta.title   || driveFile.name,
      artist:      meta.artist  || '',
      releaseDate: meta.releaseDate || null,
      duration:    meta.duration || 0,
      blobKey, thumbKey,
      driveFileId: driveFile.id,
      dateAdded:   new Date(driveFile.modifiedTime || Date.now()).getTime(),
    });
  }

  /* ─── ON TRACK ADDED / DELETED ─── */
  async function onTrackAdded(track) {
    if (!_token) return;
    try {
      await _folders();
      await Promise.all([
        _uploadAudio(track),
        track.thumbKey ? _uploadThumb(track) : Promise.resolve(),
      ]);
      await _pushIndex();
    } catch (e) {
      console.warn('[Drive] onTrackAdded failed:', e);
    }
  }

  async function onTrackDeleted(trackId, driveFileId, driveThumbId) {
    const existing = await Storage.getMeta('deletedTrackIds', []);
    if (!existing.includes(trackId)) existing.push(trackId);
    await Storage.setMeta('deletedTrackIds', existing);
    if (_token) {
      try { await _folders(); } catch {}
      await Promise.all([
        driveFileId  ? _deleteFile(driveFileId).catch(() => {})  : Promise.resolve(),
        driveThumbId ? _deleteFile(driveThumbId).catch(() => {}) : Promise.resolve(),
      ]);
      await _pushIndex().catch(() => {});
    }
  }

  /* ─── FULL DRIVE RESET ─── */
  async function resetDriveData() {
    if (!_token) return;
    _prog(5, 'Driveデータを削除中...');
    if (_fid) await _deleteFile(_fid).catch(() => {});
    _fid = null; _afid = null; _tfid = null; _lfid = null;
    await Promise.all([
      Storage.deleteMeta('driveFolderId'),
      Storage.deleteMeta('driveAudioFolderId'),
      Storage.deleteMeta('driveThumbFolderId'),
      Storage.deleteMeta('driveIndexFileId'),
      Storage.deleteMeta('driveLogsFileId'),
      Storage.deleteMeta('driveDeviceFileId'),
    ]);
    await _clearCheckpoint();
    _prog(100, '削除完了');
    _progDone();
  }

  /* ─── PUBLIC ─── */
  return {
    init,
    isLoggedIn,
    toggleLogin,
    disconnectAccount,
    toggleAutoSync,
    triggerAutoSync,
    scheduleSyncLogs,
    syncNow,
    onTrackAdded,
    onTrackDeleted,
    resetDriveData,
  };
})();
