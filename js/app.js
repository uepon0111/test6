/**
 * app.js — Main orchestrator for Sonora
 *
 * BUG FIXES / NEW FEATURES:
 *  1. uploadFiles: MP3の埋め込みメタデータ（タイトル、アーティスト、サムネイル、
 *     投稿日）を自動登録。アーティストアイコンも自動登録・更新。
 *  2. アップロード時にサムネイル/投稿日/アーティスト不明でも再生できるよう
 *     blobKey を確実に保存（null/undefined チェック追加）
 *  3. confirmReset に disconnect (アカウント連携解除) を追加
 */

const App = (() => {

  let _currentPage = 'player';

  /* ─── BOOT ─── */
  async function boot() {
    try {
      await Storage.open();
      Player.init();
      Drive.init();
      UI.init();
      await UI.loadData();
      UI.renderPlaylistTabs();
      UI.applySort();
      await Player.restoreState();
      switchPage('player');
      UI.onPageSwitch('player');
      console.log('[Sonora] Boot complete');
    } catch (err) {
      console.error('[Sonora] Boot error:', err);
      UI.toast('初期化エラー: ' + (err.message || '不明'), 'error');
    }
  }

  /* ─── PAGE NAVIGATION ─── */
  function switchPage(name) {
    _currentPage = name;
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === name + '-page');
    });
    UI.onPageSwitch(name);
    if (name === 'log')  UI.renderLogOverview();
    if (name === 'edit') UI.renderEditGrid();
  }

  function switchBotNav(btn) {
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  /* ─── FILE UPLOAD ─── */
  async function uploadFiles() {
    const queue = UI.getUploadQueue();
    if (!queue.length) return;
    UI.closeModal('upload-modal');
    UI.toast(`${queue.length}曲を追加中...`);

    const added = [];
    for (const item of queue) {
      try {
        // BUG FIX: ファイル読み込み失敗時の明示的エラーハンドリング
        let buf;
        try {
          buf = await _readAsBuffer(item.file);
        } catch (readErr) {
          console.error('File read error:', item.file.name, readErr);
          UI.toast(`ファイル読み込み失敗: ${item.title}`, 'error');
          continue;
        }

        if (!buf || buf.byteLength === 0) {
          UI.toast(`ファイルが空です: ${item.title}`, 'error');
          continue;
        }

        // Save audio blob
        const blobKey = await Storage.saveBlob(buf);

        // Save thumbnail if extracted from ID3
        let thumbKey = null;
        if (item.thumbData) {
          try {
            thumbKey = await Storage.saveBlob(item.thumbData);
          } catch (thumbErr) {
            console.warn('Thumb save error:', thumbErr);
            // サムネイル保存失敗は致命的でないので続行
          }
        }

        // アーティスト名（不明なら空文字）
        const artistName = item.artist ? item.artist.trim() : '';

        const track = await Storage.addTrack({
          title:       item.title       || item.file.name.replace(/\.[^.]+$/, ''),
          artist:      artistName,
          artists:     artistName ? [artistName] : [],
          releaseDate: item.releaseDate || null,
          duration:    item.duration    || 0,
          blobKey,
          thumbKey,
        });
        added.push(track);

        /* ─────────────────────────────────────────────────────
           アーティスト自動登録:
             1. アーティスト名が存在する場合、Artist ストアに登録（なければ作成）
             2. MP3 に埋め込まれたアーティストアイコン (artistIconData) があれば
                アーティストレコードのアイコンを更新する（未設定の場合のみ）
        ───────────────────────────────────────────────────── */
        if (artistName) {
          await _autoRegisterArtist(artistName, item.artistIconData, item.artistIconMime);
        }

      } catch (err) {
        console.error('Upload error:', item.file.name, err);
        UI.toast(`追加失敗: ${item.title}`, 'error');
      }
    }

    await UI.refreshAll();
    UI.toast(`${added.length}曲を追加しました`, 'success');

    // Push to Drive asynchronously
    for (const track of added) {
      Drive.onTrackAdded(track).catch(() => {});
    }
  }

  /**
   * アーティストを自動登録 / アイコン自動更新
   * @param {string} name - アーティスト名
   * @param {ArrayBuffer|null} iconData - MP3 から抽出したアーティストアイコン
   * @param {string|null} iconMime
   */
  async function _autoRegisterArtist(name, iconData, iconMime) {
    try {
      let artist = await Storage.getArtistByName(name);

      if (!artist) {
        // 新規作成
        let iconKey = null;
        if (iconData) {
          try { iconKey = await Storage.saveBlob(iconData); } catch {}
        }
        await Storage.createArtist(name, { iconKey });
      } else if (!artist.iconKey && iconData) {
        // 既存だがアイコン未設定 → MP3 のアイコンで更新
        try {
          const iconKey = await Storage.saveBlob(iconData);
          await Storage.updateArtist(artist.id, { iconKey });
        } catch (e) {
          console.warn('[App] Artist icon update failed:', e);
        }
      }
    } catch (e) {
      console.warn('[App] _autoRegisterArtist failed:', e);
    }
  }

  function _readAsBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = e => resolve(e.target.result);
      r.onerror = e => reject(e.target.error);
      r.readAsArrayBuffer(file);
    });
  }

  /* ─── TRACK CRUD ─── */
  async function deleteTrack(id) {
    try {
      const track = await Storage.getTrack(id);
      const driveFileId  = track?.driveFileId  || null;
      const driveThumbId = track?.driveThumbId || null;

      await Drive.onTrackDeleted(id, driveFileId, driveThumbId);
      await Storage.deleteTrack(id);
      await UI.refreshAll();
      UI.toast('曲を削除しました');
    } catch (err) {
      console.error('Delete track error:', err);
      UI.toast('削除に失敗しました', 'error');
    }
  }

  async function saveTrackEdit() {
    const data = await UI.getEditFormData();
    if (!data.id) return;
    try {
      const changes = {
        title:       data.title,
        artists:     data.artists,
        artist:      data.artist,
        releaseDate: data.releaseDate,
        tags:        data.tags,
      };
      if (data.thumbData) {
        const track = await Storage.getTrack(data.id);
        if (track.thumbKey) await Storage.deleteBlob(track.thumbKey);
        changes.thumbKey      = await Storage.saveBlob(data.thumbData);
        changes.driveThumbId  = null;
      }
      await Storage.updateTrack(data.id, changes);
      await UI.refreshAll();
      UI.closeModal('edit-track-modal');
      UI.toast('情報を保存しました', 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save track edit error:', err);
      UI.toast('保存に失敗しました', 'error');
    }
  }

  /* ─── ARTIST CRUD ─── */
  async function saveArtist() {
    const data = UI.getArtistFormData();
    if (!data.name) { UI.toast('アーティスト名を入力してください','error'); return; }
    try {
      let iconKey = null;
      if (data.iconData) {
        const res  = await fetch(data.iconData);
        const buf  = await res.arrayBuffer();
        iconKey    = await Storage.saveBlob(new Uint8Array(buf));
      }

      if (data.id) {
        const existing = await Storage.getArtist(data.id);
        const changes  = { name: data.name, color: data.color, textColor: data.textColor };
        if (iconKey !== null) {
          if (existing?.iconKey) await Storage.deleteBlob(existing.iconKey).catch(() => {});
          changes.iconKey = iconKey;
        }
        await Storage.updateArtist(data.id, changes);

        // アーティスト名が変わった場合、トラックの artist フィールドも更新
        if (existing && existing.name !== data.name) {
          await _renameArtistInTracks(existing.name, data.name);
        }

        UI.toast('アーティストを更新しました', 'success');
      } else {
        await Storage.createArtist(data.name, { iconKey, color: data.color, textColor: data.textColor });
        UI.toast(`アーティスト「${data.name}」を作成しました`, 'success');
      }
      await UI.refreshAll();
      await UI.renderArtistManager();
      UI.closeModal('artist-modal');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save artist error:', err);
      UI.toast('保存に失敗しました', 'error');
    }
  }

  /**
   * アーティスト名変更時にトラックの artist / artists フィールドも更新
   */
  async function _renameArtistInTracks(oldName, newName) {
    try {
      const tracks = await Storage.getTracks();
      for (const t of tracks) {
        const artists = (t.artists || []).map(n => n === oldName ? newName : n);
        const mainArtist = t.artist === oldName ? newName : t.artist;
        if (JSON.stringify(artists) !== JSON.stringify(t.artists || []) || mainArtist !== t.artist) {
          await Storage.updateTrack(t.id, { artists, artist: mainArtist });
        }
      }
    } catch (e) {
      console.warn('[App] _renameArtistInTracks failed:', e);
    }
  }

  async function deleteArtist(id) {
    try {
      await Storage.deleteArtist(id);
      await UI.refreshAll();
      await UI.renderArtistManager();
      UI.toast('アーティストを削除しました');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Delete artist error:', err);
    }
  }

  /* ─── PLAYLIST CRUD ─── */
  async function createPlaylist() {
    const data = UI.getNewPlaylistData();
    if (!data.name) { UI.toast('プレイリスト名を入力してください','error'); return; }
    try {
      await Storage.createPlaylist(data.name, data.desc);
      await UI.refreshPlaylists();
      UI.closeModal('new-playlist-modal');
      UI.toast(`「${data.name}」を作成しました`, 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Create playlist error:', err);
      UI.toast('作成に失敗しました', 'error');
    }
  }

  async function deletePlaylist(id) {
    try {
      await Storage.deletePlaylist(id);
      await UI.refreshPlaylists();
      UI.switchPlaylist('__all__');
      UI.toast('プレイリストを削除しました');
      Drive.triggerAutoSync();
    } catch {}
  }

  /* ─── TAG CRUD ─── */
  async function saveTag() {
    const data = UI.getTagFormData();
    if (!data.name) { UI.toast('タグ名を入力してください','error'); return; }
    try {
      if (data.id) {
        await Storage.updateTag(data.id, { name:data.name, color:data.color, textColor:data.textColor });
        UI.toast('タグを更新しました', 'success');
      } else {
        await Storage.createTag(data.name, data.color, data.textColor);
        UI.toast(`タグ「${data.name}」を作成しました`, 'success');
      }
      await UI.refreshTags();
      await UI.renderTagManager();
      UI.closeModal('tag-modal');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save tag error:', err);
      UI.toast('タグの保存に失敗しました', 'error');
    }
  }

  async function deleteTag(id) {
    try {
      await Storage.deleteTag(id);
      await UI.refreshAll();
      UI.renderTagManager();
      UI.toast('タグを削除しました');
      Drive.triggerAutoSync();
    } catch {}
  }

  /* ─── RESET ─── */
  function confirmReset(type) {
    const msgs = {
      cache:      'ページのキャッシュ（音声ファイル含む）を全て削除します。\nDrive上のデータは残ります。この操作は取り消せません。',
      all:        'キャッシュとGoogle Drive上の全データを削除します。\nこの操作は完全に取り消せません。',
      disconnect: 'Googleアカウントとの連携を解除します。\n・ページ上のキャッシュを全て削除\n・Drive内のSonoraフォルダを削除\n・アカウント連携情報を削除\n\nこの操作は取り消せません。',
    };
    const titleEl = document.getElementById('confirm-title');
    const msgEl   = document.getElementById('confirm-msg');
    const okBtn   = document.getElementById('confirm-ok-btn');
    const titles  = {
      cache:      'キャッシュリセット',
      all:        '全データリセット',
      disconnect: 'アカウント連携解除',
    };
    if (titleEl) titleEl.textContent = titles[type] || '';
    if (msgEl)   msgEl.textContent   = msgs[type]   || '';
    if (okBtn)   okBtn.onclick = async () => {
      UI.closeModal('confirm-modal');
      if (type === 'disconnect') {
        await Drive.disconnectAccount();
      } else {
        await _doReset(type);
      }
    };
    UI.openModal('confirm-modal');
  }

  async function _doReset(type) {
    try {
      UI.toast('リセット中...');
      if (type === 'all') await Drive.resetDriveData();
      // キャッシュ/全データリセット時もアカウント連携メールは保持
      // （同一アカウントで再ログインを強制。解除は disconnectAccount のみ）
      const linkedEmail = await Storage.getMeta('linkedGoogleEmail');
      await Storage.resetAll();
      if (linkedEmail) await Storage.setMeta('linkedGoogleEmail', linkedEmail);
      await UI.refreshAll();
      Player.setQueue([], -1);
      UI.toast('リセットが完了しました', 'success');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      console.error('Reset error:', err);
      UI.toast('リセットに失敗しました', 'error');
    }
  }

  /* ─── REFRESH ─── */
  async function refreshAll() {
    await UI.refreshAll();
    if (_currentPage === 'log')  UI.renderLogOverview();
    if (_currentPage === 'edit') UI.renderEditGrid();
  }

  /* ─── KEYBOARD SHORTCUTS ─── */
  function _initKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.code) {
        case 'Space':      e.preventDefault(); Player.togglePlay(); break;
        case 'ArrowRight': if (e.altKey) Player.next(); break;
        case 'ArrowLeft':  if (e.altKey) Player.prev(); break;
        case 'KeyM':       Player.toggleMute(); break;
        case 'Escape': {
          const fp = document.getElementById('full-player-overlay');
          if (fp?.classList.contains('open')) { UI.closeFullPlayer(); return; }
          document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
          break;
        }
      }
    });
  }

  /* ─── MEDIA SESSION API ─── */
  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play',          () => Player.play());
    navigator.mediaSession.setActionHandler('pause',         () => Player.pause());
    navigator.mediaSession.setActionHandler('nexttrack',     () => Player.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => Player.prev());
    document.getElementById('audio-el')?.addEventListener('play', async () => {
      const id    = Player.getCurrentTrackId();
      const track = id ? await Storage.getTrack(id) : null;
      if (!track) return;
      const artwork = [];
      if (track.thumbKey) {
        const url = await Storage.getBlobUrl(track.thumbKey);
        if (url) artwork.push({ src:url, sizes:'512x512' });
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title  || '',
        artist: track.artist || '',
        artwork,
      });
    });
  }

  /* ─── UNLOAD GUARD ─── */
  function _initUnloadGuard() {
    window.addEventListener('beforeunload', e => {
      if (Player.isPlaying()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ─── ENTRY POINT ─── */
  document.addEventListener('DOMContentLoaded', async () => {
    _initKeyboard();
    _initMediaSession();
    _initUnloadGuard();
    await boot();
  });

  /* ─── PUBLIC ─── */
  return {
    switchPage, switchBotNav,
    uploadFiles,
    deleteTrack, saveTrackEdit,
    createPlaylist, deletePlaylist,
    saveTag, deleteTag,
    saveArtist, deleteArtist,
    confirmReset,
    refreshAll,
  };
})();
