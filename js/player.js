/**
 * player.js — Audio playback engine for Sonora
 *
 * BUG FIXES:
 *   - Shuffle: restoreState では origQueue から再シャッフルして毎回異なる順序に
 *   - Shuffle toggle: aria-pressed + title でボタン状態を確実に反映
 */

const Player = (() => {
  /* ─── STATE ─── */
  const audio = document.getElementById('audio-el');

  let _queue      = [];
  let _origQueue  = [];
  let _currentIdx = -1;
  let _shuffle    = false;
  let _repeat     = 'none';
  let _volume     = 80;
  let _speed      = 1.0;
  let _muted      = false;

  let _playStartTime  = null;
  let _playedSeconds  = 0;
  let _loggedTrackId  = null;
  let _logFlushTimer  = null;

  /* ─── QUEUE ─── */
  function setQueue(trackIds, startIndex = 0) {
    _origQueue  = [...trackIds];
    _queue      = [...trackIds];
    _currentIdx = Math.max(0, Math.min(startIndex, _queue.length - 1));
    if (_shuffle) _shuffleQueue();
    _loadCurrent();
  }

  function appendToQueue(trackIds) {
    const newIds = trackIds.filter(id => !_queue.includes(id));
    _origQueue.push(...newIds);
    _queue.push(...newIds);
  }

  function getCurrentTrackId() {
    return _queue[_currentIdx] ?? null;
  }

  /* ─── SHUFFLE ─── */
  function _shuffleQueue() {
    if (_queue.length === 0) return;
    const current = getCurrentTrackId();
    const rest    = _queue.filter(id => id !== current);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    if (current && _queue.includes(current)) {
      _queue = [current, ...rest];
      _currentIdx = 0;
    } else {
      _queue = rest;
      _currentIdx = Math.min(_currentIdx, Math.max(0, rest.length - 1));
    }
  }

  function toggleShuffle() {
    _shuffle = !_shuffle;
    if (_shuffle) {
      _shuffleQueue();
    } else {
      const currentId = getCurrentTrackId();
      _queue = [..._origQueue];
      const idx = currentId ? _queue.indexOf(currentId) : -1;
      _currentIdx = idx >= 0 ? idx : 0;
    }
    _updateShuffleUI();
    _saveState();
  }

  /* ─── REPEAT ─── */
  function cycleRepeat() {
    const modes = ['none', 'all', 'one'];
    _repeat = modes[(modes.indexOf(_repeat) + 1) % modes.length];
    _updateRepeatUI();
    _saveState();
  }

  /* ─── LOAD & PLAY ─── */
  async function _loadCurrent() {
    _flushLog();
    const trackId = getCurrentTrackId();
    if (!trackId) { _updateTrackUI(null); return; }

    try {
      const track = await Storage.getTrack(trackId);
      if (!track) { next(); return; }

      const url = await Storage.getAudioBlobUrl(trackId);
      if (!url) {
        UI && UI.toast('音声データが見つかりません: ' + track.title, 'error');
        next();
        return;
      }

      audio.src = url;
      audio.playbackRate = _speed;
      audio.volume       = _muted ? 0 : _volume / 100;
      audio.load();

      _loggedTrackId = trackId;
      _playStartTime = null;
      _playedSeconds = 0;

      await _updateTrackUI(track);
      audio.play().catch(() => _updatePlayButtonUI(false));
    } catch (err) {
      console.error('Load error:', err);
    }
  }

  /* ─── CONTROLS ─── */
  function togglePlay() {
    if (audio.paused) {
      if (!audio.src && _queue.length > 0) { _currentIdx = 0; _loadCurrent(); return; }
      audio.play();
    } else {
      audio.pause();
    }
  }

  function play()  { if (audio.src) audio.play(); }
  function pause() { audio.pause(); }

  function next() {
    if (_queue.length === 0) return;
    if (_repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
    const nextIdx = _currentIdx + 1;
    if (nextIdx >= _queue.length) {
      if (_repeat === 'all') { _currentIdx = 0; }
      else { _currentIdx = 0; _loadCurrent(); audio.pause(); _updatePlayButtonUI(false); return; }
    } else {
      _currentIdx = nextIdx;
    }
    _loadCurrent();
  }

  function prev() {
    if (!audio || audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (_queue.length === 0) return;
    _currentIdx = Math.max(0, _currentIdx - 1);
    _loadCurrent();
  }

  function seekTo(pct) {
    if (!audio.duration) return;
    audio.currentTime = audio.duration * Math.max(0, Math.min(1, pct));
  }

  function seekToSeconds(s) {
    if (!audio.duration) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, s));
  }

  function setVolume(val) {
    _volume = parseInt(val, 10);
    _muted  = false;
    audio.volume = _volume / 100;
    _updateVolumeUI();
    _saveState();
  }

  function toggleMute() {
    _muted = !_muted;
    audio.volume = _muted ? 0 : _volume / 100;
    _updateVolumeUI();
  }

  function setSpeed(val) {
    _speed = parseFloat(val);
    audio.playbackRate = _speed;
    _saveState();
  }

  /* ─── PLAY LOG ─── */
  function _startLogTimer() {
    _playStartTime = Date.now();
    clearInterval(_logFlushTimer);
    _logFlushTimer = setInterval(_accumulateLog, 30000);
  }

  function _pauseLogTimer() {
    _accumulateLog();
    clearInterval(_logFlushTimer);
    _logFlushTimer = null;
  }

  function _accumulateLog() {
    if (_playStartTime) {
      _playedSeconds += (Date.now() - _playStartTime) / 1000;
      _playStartTime = Date.now();
    }
  }

  function _flushLog() {
    _accumulateLog();
    clearInterval(_logFlushTimer);
    _logFlushTimer = null;
    if (_loggedTrackId && _playedSeconds >= 1) {
      Storage.addLog(_loggedTrackId, Math.round(_playedSeconds)).catch(() => {});
      if (typeof Drive !== 'undefined' && Drive.isLoggedIn()) Drive.scheduleSyncLogs();
    }
    _playedSeconds = 0; _loggedTrackId = null; _playStartTime = null;
  }

  /* ─── AUDIO EVENTS ─── */
  audio.addEventListener('play',      () => { _updatePlayButtonUI(true);  _startLogTimer(); });
  audio.addEventListener('pause',     () => { _updatePlayButtonUI(false); _pauseLogTimer(); });
  audio.addEventListener('ended',     () => { _pauseLogTimer(); _flushLog(); next(); });
  audio.addEventListener('timeupdate', _onTimeUpdate);
  audio.addEventListener('error',     () => setTimeout(next, 1000));

  function _onTimeUpdate() {
    if (!audio.duration) return;
    _updateProgressUI(audio.currentTime / audio.duration, audio.currentTime, audio.duration);
  }

  /* ─── UI UPDATERS ─── */
  async function _updateTrackUI(track) {
    const pwTitle   = document.getElementById('pw-title');
    const pwArtist  = document.getElementById('pw-artist');
    const pwArt     = document.getElementById('pw-album-art');
    const fpoTitle  = document.getElementById('fpo-title');
    const fpoArtist = document.getElementById('fpo-artist');
    const fpoArt    = document.getElementById('fpo-album-art');
    const mpTitle   = document.getElementById('mp-title');
    const mpArtist  = document.getElementById('mp-artist');
    const mpThumb   = document.getElementById('mp-thumb');

    if (!track) {
      [pwTitle, fpoTitle, mpTitle].forEach(el => { if(el) el.textContent = '曲を選択してください'; });
      [pwArtist, fpoArtist, mpArtist].forEach(el => { if(el) el.textContent = '—'; });
      const mp = document.getElementById('mini-player');
      if (mp) mp.classList.add('no-track');
      return;
    }

    const mp = document.getElementById('mini-player');
    if (mp) mp.classList.remove('no-track');

    const name   = track.title || '不明なタイトル';
    const artist = (Array.isArray(track.artists) && track.artists.length)
      ? track.artists.join(', ')
      : (track.artist || '不明なアーティスト');

    if (pwTitle)  pwTitle.textContent  = name;
    if (pwArtist) pwArtist.textContent = artist;
    if (fpoTitle)  fpoTitle.textContent  = name;
    if (fpoArtist) fpoArtist.textContent = artist;
    if (mpTitle)  mpTitle.textContent  = name;
    if (mpArtist) mpArtist.textContent = artist;

    const thumbUrl = track.thumbKey ? await Storage.getBlobUrl(track.thumbKey) : null;
    _setArtUI(pwArt,  thumbUrl);
    _setArtUI(fpoArt, thumbUrl);
    if (mpThumb) {
      mpThumb.innerHTML = thumbUrl
        ? `<img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover">`
        : '<i class="fa-solid fa-music"></i>';
    }

    if (typeof UI !== 'undefined') UI.onTrackChange(track.id);
    document.title = `${name} — Sonora`;
  }

  function _setArtUI(container, thumbUrl) {
    if (!container) return;
    const badge = container.querySelector('.now-playing-badge');
    if (thumbUrl) {
      container.querySelectorAll('img, .art-placeholder').forEach(el => el.remove());
      const img = document.createElement('img');
      img.src = thumbUrl;
      container.insertBefore(img, badge);
    } else {
      container.querySelectorAll('img').forEach(el => el.remove());
      if (!container.querySelector('.art-placeholder')) {
        const ic = document.createElement('i');
        ic.className = 'fa-solid fa-music art-placeholder';
        container.insertBefore(ic, badge);
      }
    }
  }

  function _updatePlayButtonUI(playing) {
    ['pw-play', 'mp-play', 'fpo-play'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const icon = btn.querySelector('i');
      if (!icon) return;
      icon.classList.toggle('fa-play',  !playing);
      icon.classList.toggle('fa-pause',  playing);
    });
  }

  function _updateProgressUI(pct, cur, total) {
    const w = (pct * 100).toFixed(2) + '%';
    ['pw-progress-fill', 'fpo-progress-fill'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.width = w;
    });
    const mpProg = document.getElementById('mp-progress');
    if (mpProg) mpProg.style.width = w;

    const fmt = s => {
      if (!s || isNaN(s)) return '0:00';
      return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    };
    const pairs = [['pw-time-cur',cur],['pw-time-total',total],['fpo-time-cur',cur],['fpo-time-total',total]];
    pairs.forEach(([id, val]) => { const el = document.getElementById(id); if(el) el.textContent = fmt(val); });
  }

  /**
   * BUG FIX: aria-pressed と title も更新してシャッフルボタンの
   * オン/オフが確実に視覚化されるようにする
   */
  function _updateShuffleUI() {
    ['pw-shuffle', 'fpo-shuffle'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle('active', _shuffle);
      btn.setAttribute('aria-pressed', String(_shuffle));
      btn.title = _shuffle ? 'シャッフル: オン（クリックでオフ）' : 'シャッフル: オフ（クリックでオン）';
    });
  }

  function _updateRepeatUI() {
    ['pw-repeat', 'fpo-repeat'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const icon = btn.querySelector('i');
      btn.classList.toggle('active', _repeat !== 'none');
      btn.dataset.repeat = _repeat;
      if (icon) icon.className = 'fa-solid fa-repeat';
    });
  }

  function _updateVolumeUI() {
    const iconClass = _muted || _volume === 0 ? 'fa-solid fa-volume-xmark'
      : _volume < 40 ? 'fa-solid fa-volume-low'
      : 'fa-solid fa-volume-high';

    ['pw-vol-icon', 'fpo-vol-icon'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const i = btn.querySelector('i');
      if (i) i.className = iconClass;
    });
    ['pw-vol', 'fpo-vol'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !_muted) el.value = _volume;
    });
  }

  /* ─── PROGRESS BAR CLICK ─── */
  function _bindProgressBar(barId) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.addEventListener('click', e => {
      const rect = bar.getBoundingClientRect();
      seekTo((e.clientX - rect.left) / rect.width);
    });
    let dragging = false;
    bar.addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = bar.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    bar.addEventListener('touchmove', e => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect  = bar.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width)));
    }, { passive: false });
  }

  /* ─── SAVE / RESTORE STATE ─── */
  function _saveState() {
    Storage.setMeta('playerState', {
      queue:      _queue,
      origQueue:  _origQueue,
      currentIdx: _currentIdx,
      shuffle:    _shuffle,
      repeat:     _repeat,
      volume:     _volume,
      speed:      _speed,
    }).catch(() => {});
  }

  async function restoreState() {
    const state = await Storage.getMeta('playerState');
    if (!state) return;

    _origQueue  = state.origQueue  || [];
    _currentIdx = state.currentIdx ?? -1;
    _shuffle    = state.shuffle    || false;
    _repeat     = state.repeat     || 'none';
    _volume     = state.volume     ?? 80;
    _speed      = state.speed      || 1.0;

    /**
     * BUG FIX: シャッフル ON で復元した場合、保存済みシャッフル順を
     * そのまま使うと毎回同じ順序になる。origQueue から再シャッフルする。
     */
    if (_shuffle && _origQueue.length > 0) {
      _queue      = [..._origQueue];
      _currentIdx = 0;
      _shuffleQueue();
    } else {
      _queue = state.queue || [];
    }

    audio.volume       = _volume / 100;
    audio.playbackRate = _speed;

    ['pw-vol','fpo-vol'].forEach(id => { const el=document.getElementById(id); if(el) el.value=_volume; });
    ['pw-speed','fpo-speed'].forEach(id => { const el=document.getElementById(id); if(el) el.value=_speed; });

    _updateShuffleUI();
    _updateRepeatUI();
    _updateVolumeUI();

    const trackId = getCurrentTrackId();
    if (trackId) {
      const track = await Storage.getTrack(trackId);
      if (track) await _updateTrackUI(track);
    }
  }

  /* ─── INIT ─── */
  function init() {
    _bindProgressBar('pw-progress-bar');
    _bindProgressBar('fpo-progress-bar');

    audio.volume       = _volume / 100;
    audio.playbackRate = _speed;

    ['pw-speed','fpo-speed'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', e => setSpeed(e.target.value));
    });
    ['pw-vol','fpo-vol'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', e => setVolume(e.target.value));
    });
  }

  /* ─── GETTERS ─── */
  function isPlaying()       { return !audio.paused; }
  function isShuffle()       { return _shuffle; }
  function getRepeat()       { return _repeat; }
  function getQueue()        { return [..._queue]; }
  function getCurrentIndex() { return _currentIdx; }

  return {
    init, restoreState,
    setQueue, appendToQueue, getCurrentTrackId, getQueue, getCurrentIndex,
    togglePlay, play, pause, next, prev, seekTo, seekToSeconds,
    setVolume, toggleMute, setSpeed,
    toggleShuffle, cycleRepeat,
    isPlaying, isShuffle, getRepeat,
  };
})();
