// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const API = 'http://127.0.0.1:8765/api';
let currentSession = null;

// wordMaps[fileId] = [{word, start, end, segId, globalIdx}]
const wordMaps = {};

// Take-level deletions (takes panel)
const deletions = {};

// File IDs currently having silence removed — set immediately on click so the
// spinner shows without waiting for the 3-second poll to catch up.
const silenceRemovingNow = new Set();

// Take-panel word selection (mousedown-drag in takes grid)
let takesSel = null;
let takesSelecting = false, takesSelFid = null, takesSelAnchor = null;

// ── Sentence groups ──────────────────────────────────────────────────────────
let groupResult = null;
let groupRatings = {};   // { [group_id]: 'good' | 'meh' | 'bad' }

// Per-candidate word deletions  key = `${groupId}_${ci}`
const candDels = {};
// Per-candidate manual trim offsets  key = `${groupId}_${ci}`
// { startTrim: ms (positive = cut from front), endTrim: ms (positive = cut from back) }
const candTrims = {};
const TRIM_STEP_MS = 50;
// Current active word selection — shared across candidates and assembly
// {seltype:'cand'|'asm', key, fromLocalIdx, toLocalIdx}
let wordSel = null;
let wordSelAnchorKey = null;
let wordSelAnchorIdx = null;

// ── Assembly ─────────────────────────────────────────────────────────────────
// [{id, groupId, fileId, sourceName, start, end, sgDels:[{start,end}]}]
let assembly = [];
let asmDragSrcIdx = null;
let groupDragSrcIdx = null;

// Audio
const miniAudios = {};
let rangePlayer = null;

// ── Web Audio Engine ──────────────────────────────────────────────────────────
// Uses AudioBufferSourceNode (not <audio> element seeking) for sample-accurate
// start/stop and precise GainNode fade scheduling.  The <audio> element is kept
// only for the waveform/scrub bar; all actual playback goes through the engine.

let _wactx = null;                    // shared AudioContext
const _audioBufferCache = new Map();  // fileId → Promise<AudioBuffer>

function _getAudioCtx() {
  if (!_wactx) {
    _wactx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_wactx.state === 'suspended') _wactx.resume();
  return _wactx;
}

// Fetch and decode a file's audio into an AudioBuffer (cached per fileId).
function _loadAudioBuffer(fileId) {
  if (_audioBufferCache.has(fileId)) return _audioBufferCache.get(fileId);
  const url = `${API}/audio/${currentSession}/${fileId}`;
  const p = fetch(url)
    .then(r => r.arrayBuffer())
    .then(ab => _getAudioCtx().decodeAudioData(ab));
  _audioBufferCache.set(fileId, p);
  return p;
}

// Invalidate cached buffer when files change (call on upload / new session).
function _clearAudioCache(fileId) {
  if (fileId) _audioBufferCache.delete(fileId);
  else _audioBufferCache.clear();
}

// Play a sequence of ranges from one AudioBuffer with 25ms fades at every boundary.
// Returns a cancel function.  onComplete is called when all ranges finish.
function _playRanges(audioBuf, ranges, onComplete) {
  const ctx   = _getAudioCtx();
  const FADE_IN  = 0.025;
  const FADE_OUT = 0.025;
  const GAP   = 0.003;   // 3 ms gap between consecutive ranges (avoids scheduler glitch)

  const sources = [];
  let startAt = ctx.currentTime + 0.03;  // small lookahead so first note is never late
  let completionTimer = null;

  for (let i = 0; i < ranges.length; i++) {
    const r   = ranges[i];
    const dur = Math.max(0, r.end - r.start);
    if (dur <= 0) continue;

    const buf  = ctx.createBufferSource();
    buf.buffer = audioBuf;

    const gain = ctx.createGain();
    buf.connect(gain);
    gain.connect(ctx.destination);

    // Fade in at range start
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + Math.min(FADE_IN, dur * 0.4));

    // Fade out at range end
    const fadeOutStart = startAt + Math.max(dur - FADE_OUT, dur * 0.9);
    gain.gain.setValueAtTime(1, fadeOutStart);
    gain.gain.linearRampToValueAtTime(0, startAt + dur);

    buf.start(startAt, r.start, dur);
    buf.stop(startAt + dur + 0.001);
    sources.push({ buf, gain });

    startAt += dur + GAP;
  }

  // Fire onComplete after all ranges have played
  const totalDur = startAt - ctx.currentTime;
  if (onComplete && totalDur > 0) {
    completionTimer = setTimeout(onComplete, totalDur * 1000);
  }

  return function cancel() {
    if (completionTimer) clearTimeout(completionTimer);
    for (const { buf, gain } of sources) {
      const t = ctx.currentTime;
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.02);
        buf.stop(t + 0.02);
      } catch (_) {}
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  await ensureSession();
  setupDropZone();

  document.getElementById('file-input').addEventListener('change', e => {
    uploadFiles([...e.target.files]); e.target.value = '';
  });
  document.getElementById('btn-new-session').addEventListener('click', newSession);
  document.getElementById('btn-process-all').addEventListener('click', processAll);
  document.getElementById('btn-regroup').addEventListener('click', runGroupRank);
  document.getElementById('btn-clear-assembly').addEventListener('click', clearAssembly);
  document.getElementById('btn-export').addEventListener('click', exportAssembly);

  // Toolbar
  document.getElementById('btn-sel-play').addEventListener('click', playWordSel);
  document.getElementById('btn-sel-delete').addEventListener('click', deleteWordSel);
  document.getElementById('btn-sel-clear').addEventListener('click', clearWordSel);

  // Word clicks delegated per section
  document.getElementById('groups-list').addEventListener('click', onWordClick);
  // assembly-list: no word-click interactions (read-only display)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearWordSel(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && wordSel) {
      e.preventDefault(); deleteWordSel();
    }
  });
  document.addEventListener('mouseup', () => { takesSelecting = false; });

  setInterval(refreshTakes, 3000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSession() {
  const saved = localStorage.getItem('voiceEditorSession');
  if (saved) {
    try {
      const r = await fetch(`${API}/session/${saved}/status`);
      if (r.ok) { currentSession = saved; setLabel(saved); return; }
    } catch (_) {}
  }
  await createSession();
}

async function createSession() {
  const r = await fetch(`${API}/session/new`, { method: 'POST' });
  const d = await r.json();
  currentSession = d.session_id;
  localStorage.setItem('voiceEditorSession', currentSession);
  setLabel(currentSession);
}

function setLabel(id) { document.getElementById('session-label').textContent = id; }

async function newSession() {
  if (!confirm('Start a new session?')) return;
  localStorage.removeItem('voiceEditorSession');
  assembly = []; groupResult = null; takesSel = null; wordSel = null;
  wordSelAnchorKey = null; wordSelAnchorIdx = null;
  [wordMaps, deletions, candDels, candTrims].forEach(o => Object.keys(o).forEach(k => delete o[k]));
  _clearAudioCache();
  renderAssembly(); hideToolbar();
  document.getElementById('groups-section').style.display = 'none';
  await createSession();
  document.getElementById('takes-grid').innerHTML = '';
  ['takes-section','assembly-section'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('upload-actions').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────────────────────────

function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); uploadFiles([...e.dataTransfer.files]); });
  zone.addEventListener('click', e => { if (e.target.tagName !== 'LABEL') document.getElementById('file-input').click(); });
}

async function uploadFiles(files) {
  if (!files.length) return;
  toast(`Uploading ${files.length} file(s)…`);
  const form = new FormData();
  files.forEach(f => form.append('files', f));
  const r = await fetch(`${API}/session/${currentSession}/upload`, { method: 'POST', body: form });
  if (!r.ok) { toast('Upload failed'); return; }
  toast(`Uploaded ${files.length} file(s)`);
  document.getElementById('upload-actions').style.display = 'flex';
  await refreshTakes();
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcription / silence
// ─────────────────────────────────────────────────────────────────────────────

function setProcessStatus(msg) {
  const el = document.getElementById('process-status');
  if (msg) { el.textContent = msg; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

async function processAll() {
  const btn = document.getElementById('btn-process-all');
  btn.disabled = true;

  // Step 1: Transcribe
  setProcessStatus('⏳ Step 1/3 — Transcribing with Whisper…');
  await fetch(`${API}/session/${currentSession}/transcribe_all`, { method: 'POST' });

  // Wait until all files are done transcribing
  await (async () => {
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await (await fetch(`${API}/session/${currentSession}/status`)).json();
      const files = Object.values(s.files || {});
      if (!files.length) break;
      const pending = files.filter(f => f.status === 'transcribing').length;
      const done    = files.filter(f => f.status === 'done').length;
      setProcessStatus(`⏳ Step 1/3 — Transcribing… (${done}/${files.length} done)`);
      await refreshTakes();
      if (pending === 0) break;
    }
  })();

  // Step 2: Remove silence
  setProcessStatus('⏳ Step 2/3 — Removing silence…');
  const s2 = await (await fetch(`${API}/session/${currentSession}/status`)).json();
  const toProcess = Object.entries(s2.files || {})
    .filter(([, f]) => f.status === 'done' && !f.silence_removed)
    .map(([fid]) => fid);
  toProcess.forEach(fid => silenceRemovingNow.add(fid));
  if (toProcess.length) {
    await Promise.all(toProcess.map(fid =>
      fetch(`${API}/session/${currentSession}/remove_silence/${fid}`, { method: 'POST' })
    ));
    // Wait for silence removal to finish
    while (true) {
      await new Promise(r => setTimeout(r, 1500));
      const s = await (await fetch(`${API}/session/${currentSession}/status`)).json();
      await refreshTakes();
      const pending = Object.values(s.files || {}).filter(f => f.removing_silence).length;
      if (pending === 0) break;
    }
  }

  // (processed audio is always used when available)

  // Step 3: Group & Rank
  setProcessStatus('⏳ Step 3/3 — Grouping & ranking sentences…');
  await runGroupRank();

  setProcessStatus('');
  btn.disabled = false;
}

async function transcribeAll() {
  toast('Starting transcription… (first run downloads ~145 MB Whisper model)');
  await fetch(`${API}/session/${currentSession}/transcribe_all`, { method: 'POST' });
}
async function transcribeOne(fid) {
  toast('Transcribing…');
  await fetch(`${API}/session/${currentSession}/transcribe/${fid}`, { method: 'POST' });
}
async function removeSilenceAll() {
  const s = await (await fetch(`${API}/session/${currentSession}/status`)).json();
  const fids = Object.entries(s.files || {})
    .filter(([, f]) => !f.silence_removed)
    .map(([fid]) => fid);
  if (!fids.length) { toast('Silence already removed from all files'); return; }
  fids.forEach(fid => silenceRemovingNow.add(fid));
  renderTakes(s.files);  // show spinners immediately
  toast(`Removing silence from ${fids.length} file(s)…`);
  await Promise.all(fids.map(fid =>
    fetch(`${API}/session/${currentSession}/remove_silence/${fid}`, { method: 'POST' })
  ));
}
async function removeSilenceOne(fid) {
  silenceRemovingNow.add(fid);
  await refreshTakes();  // show spinner immediately
  toast('Removing silence…');
  await fetch(`${API}/session/${currentSession}/remove_silence/${fid}`, { method: 'POST' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Takes panel
// ─────────────────────────────────────────────────────────────────────────────

async function refreshTakes() {
  if (!currentSession) return;
  try {
    const r = await fetch(`${API}/session/${currentSession}/status`);
    if (!r.ok) return;
    const data = await r.json();
    const files = data.files || {};
    if (!Object.keys(files).length) return;
    ['takes-section','assembly-section'].forEach(id => document.getElementById(id).style.display = 'block');
    document.getElementById('upload-actions').style.display = 'flex';
    renderTakes(files);
    const done = Object.values(files).filter(f => f.status === 'done').length;
    void done;
  } catch (_) {}
}

function renderTakes(files) {
  const grid = document.getElementById('takes-grid');
  const useProcessed = true;  // always use silence-removed audio when available
  for (const [fid, fdata] of Object.entries(files)) {
    if (fdata.status === 'done' && fdata.segments?.length && !wordMaps[fid])
      buildWordMap(fid, fdata.segments);
    if (fdata.silence_removed) silenceRemovingNow.delete(fid);
    let card = document.getElementById(`take-${fid}`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'take-card'; card.id = `take-${fid}`;
      grid.appendChild(card);
    }
    renderCard(card, fid, fdata, useProcessed);
  }
}

function buildWordMap(fid, segments) {
  let idx = 0;
  const words = [];
  for (const seg of segments) {
    const raw = seg.words || [];
    if (raw.length) {
      for (const w of raw)
        words.push({ word: w.word.replace(/^\s+/, ''), start: w.start, end: w.end, segId: seg.id, globalIdx: idx++ });
    } else {
      words.push({ word: seg.text, start: seg.start, end: seg.end, segId: seg.id, globalIdx: idx++ });
    }
  }
  wordMaps[fid] = words;
}

function renderCard(card, fid, fdata, useProcessed) {
  const audioSrc = `${API}/audio/${currentSession}/${fid}${useProcessed && fdata.silence_removed_path ? '?processed=true' : ''}`;
  const words = wordMaps[fid] || [];
  const dels  = deletions[fid] || [];
  const statusLabel = { uploaded:'Uploaded', transcribing:'Transcribing…', done:'Done', error:'Error' };
  const statusCls   = { uploaded:'', transcribing:'transcribing', done:'done', error:'error' };

  let transcriptHtml = '';
  if (words.length) {
    const bySegId = {};
    for (const w of words) (bySegId[w.segId] = bySegId[w.segId] || []).push(w);
    const segIds = [...new Set(words.map(w => w.segId))];
    transcriptHtml = segIds.map(sid => {
      const sw = bySegId[sid];
      const wordsHtml = sw.map(w => {
        const isDel = isTakeWordDeleted(fid, w);
        const isSel = takesSel?.fileId === fid && w.globalIdx >= takesSel.fromIdx && w.globalIdx <= takesSel.toIdx;
        const cls = ['word', isDel ? 'deleted' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
        return `<span class="${cls}" data-fid="${fid}" data-idx="${w.globalIdx}" data-start="${w.start}" data-end="${w.end}">${escHtml(w.word)}</span>`;
      }).join(' ');
      return `<div class="sentence-block">
        <span class="sentence-label" data-fid="${fid}" data-seg-start="${sw[0].start}" data-seg-end="${sw[sw.length-1].end}">
          ${fmt(sw[0].start)} <span class="sel-hint">— click to select sentence</span>
        </span>
        <div class="words-line">${wordsHtml}</div>
      </div>`;
    }).join('');
  } else if (fdata.status === 'transcribing') {
    transcriptHtml = `<div class="no-transcript"><span class="spinner"></span> Transcribing…</div>`;
  } else if (fdata.status === 'done') {
    transcriptHtml = `<div class="no-transcript">No words found</div>`;
  } else {
    transcriptHtml = `<div class="no-transcript">Transcribe to see words</div>`;
  }

  card.innerHTML = `
    <div class="take-card-header">
      <span class="take-name" title="${escHtml(fdata.original_name)}">${escHtml(fdata.original_name)}</span>
      <span class="badge ${statusCls[fdata.status]}">${statusLabel[fdata.status] || fdata.status}</span>
      ${fdata.silence_removed ? '<span class="badge silence">✓ Silence removed</span>' : ''}
      ${(silenceRemovingNow.has(fid) && !fdata.silence_removed) ? '<span class="badge transcribing"><span class="spinner"></span> Removing silence…</span>' : ''}
    </div>
    <div class="take-card-actions">
      ${fdata.status !== 'transcribing' ? `<button class="ghost" onclick="transcribeOne('${fid}')">Transcribe</button>` : ''}
      ${(!fdata.silence_removed && !silenceRemovingNow.has(fid)) ? `<button class="ghost" onclick="removeSilenceOne('${fid}')">Remove Silence</button>` : ''}
      ${dels.length ? `<button class="ghost danger-ghost" onclick="clearTakeDels('${fid}')">Restore Deleted</button>` : ''}
    </div>
    <div class="mini-player">
      <button class="mini-play-btn" id="mpbtn-${fid}" onclick="toggleMiniPlay('${fid}','${audioSrc}')">▶</button>
      <div class="progress-wrap" onclick="seekMini(event,'${fid}')">
        <div class="progress-fill" id="pb-${fid}"></div>
      </div>
      <span class="time-lbl" id="tl-${fid}">0:00</span>
    </div>
    <div class="transcript-area" id="ta-${fid}">${transcriptHtml}</div>
  `;

  const ta = card.querySelector('.transcript-area');
  ta.addEventListener('mousedown', onTakesWordMousedown);
  ta.addEventListener('mouseover', onTakesWordMouseover);
  ta.querySelectorAll('.sentence-label').forEach(lbl => {
    lbl.addEventListener('click', () => {
      const s = parseFloat(lbl.dataset.segStart), e = parseFloat(lbl.dataset.segEnd);
      const sw = (wordMaps[fid] || []).filter(w => w.start >= s - 0.01 && w.end <= e + 0.01);
      if (sw.length) setTakesSel(fid, sw[0].globalIdx, sw[sw.length-1].globalIdx);
    });
  });
}

function onTakesWordMousedown(e) {
  const span = e.target.closest('.word');
  if (!span || span.classList.contains('deleted')) return;
  clearWordSel();
  takesSelecting = true; takesSelFid = span.dataset.fid; takesSelAnchor = parseInt(span.dataset.idx);
  setTakesSel(takesSelFid, takesSelAnchor, takesSelAnchor);
  e.preventDefault();
}
function onTakesWordMouseover(e) {
  if (!takesSelecting) return;
  const span = e.target.closest('.word');
  if (!span || span.dataset.fid !== takesSelFid) return;
  setTakesSel(takesSelFid, takesSelAnchor, parseInt(span.dataset.idx));
}
function setTakesSel(fid, from, to) {
  takesSel = { fileId: fid, fromIdx: Math.min(from, to), toIdx: Math.max(from, to) };
  document.querySelectorAll('.word.selected').forEach(el => el.classList.remove('selected'));
  for (let i = takesSel.fromIdx; i <= takesSel.toIdx; i++) {
    const el = document.querySelector(`.word[data-fid="${fid}"][data-idx="${i}"]`);
    if (el) el.classList.add('selected');
  }
}
function isTakeWordDeleted(fid, w) {
  const mid = (w.start + w.end) / 2;
  return (deletions[fid] || []).some(d => mid >= d.start && mid <= d.end);
}
function clearTakeDels(fid) { delete deletions[fid]; refreshTakes(); toast('Deletions restored'); }

// ─────────────────────────────────────────────────────────────────────────────
// Group & Rank
// ─────────────────────────────────────────────────────────────────────────────

async function runGroupRank() {
  Object.keys(candDels).forEach(k => delete candDels[k]);
  Object.keys(candTrims).forEach(k => delete candTrims[k]);
  clearWordSel();

  document.getElementById('groups-section').style.display = 'block';
  document.getElementById('groups-list').innerHTML = '';
  document.getElementById('groups-loading').style.display = 'flex';
  document.getElementById('btn-regroup').disabled = true;

  try {
    const r = await fetch(`${API}/session/${currentSession}/auto_assemble`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast('Failed: ' + (err.detail || r.status)); return;
    }
    groupResult = await r.json();
    renderGroups();
    const n = groupResult.groups?.length || 0;
    document.getElementById('groups-stats').textContent = `${n} sentence group${n !== 1 ? 's' : ''}`;
    toast(`Found ${n} sentence groups`);
  } catch (e) {
    toast('Error: ' + e.message);
  } finally {
    document.getElementById('groups-loading').style.display = 'none';
    document.getElementById('btn-regroup').disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Group card rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderGroups() {
  const list = document.getElementById('groups-list');
  if (!groupResult?.groups?.length) {
    list.innerHTML = '<div class="no-transcript" style="padding:20px 0">No sentence groups found.</div>';
    document.getElementById('btn-add-all').style.display = 'none';
    return;
  }
  list.innerHTML = groupResult.groups.map((g, idx) => renderGroupCard(g, idx)).join('');
  document.getElementById('btn-add-all').style.display = '';
}

function renderGroupCard(g, idx) {
  if (idx === undefined) idx = groupResult?.groups?.findIndex(gr => gr.group_id === g.group_id) ?? 0;
  const addedItem = assembly.find(a => a.groupId === g.group_id);

  const candidatesHtml = g.candidates.map((c, ci) => {
    const key = `${g.group_id}_${ci}`;
    const scoreCls = c.score >= 75 ? 'high' : c.score >= 50 ? 'mid' : 'low';
    const d = c.score_details || {};
    const details = [
      d.fillers   > 0 ? `${d.fillers} filler${d.fillers > 1 ? 's' : ''}` : '',
      d.stumbles  > 0 ? `${d.stumbles} stumble${d.stumbles > 1 ? 's' : ''}` : '',
      d.silence_gaps > 0 ? `${d.silence_gaps} pause${d.silence_gaps > 1 ? 's' : ''}` : '',
      d.avg_confidence ? `conf ${(d.avg_confidence * 100).toFixed(0)}%` : '',
    ].filter(Boolean).join(' · ');

    const segWords = getCandWords(g.group_id, ci);
    const dels     = candDels[key] || [];
    const hasDels  = dels.length > 0;

    let wordsHtml;
    if (segWords.length) {
      wordsHtml = segWords.map((w, li) => {
        const mid  = (w.start + w.end) / 2;
        const isDel = dels.some(d => d.globalIdx === w.globalIdx);
        const isSel = wordSel?.key === key && li >= wordSel.fromLocalIdx && li <= wordSel.toLocalIdx;
        const cls  = ['cand-word', isDel ? 'deleted' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
        return `<span class="${cls}" data-seltype="cand" data-key="${key}" data-gid="${g.group_id}" data-ci="${ci}" data-fid="${c.file_id}" data-lidx="${li}" data-start="${w.start}" data-end="${w.end}">${escHtml(w.word)}</span>`;
      }).join(' ');
    } else {
      wordsHtml = `<span class="cand-word-plain">${escHtml(c.text)}</span>`;
    }

    return `<div class="candidate-row" id="cand-${key}" draggable="true"
      ondragstart="candDragStart(event,${g.group_id},${ci})"
      ondragover="candDragOver(event)"
      ondrop="candDrop(event,${g.group_id},${ci})"
      ondragleave="event.currentTarget.classList.remove('drag-over')">
      <div class="cand-header">
        <span class="cand-drag-handle" title="Drag to reorder">⠿</span>
        <span class="cand-rank">#${ci + 1}</span>
        <span class="cand-score ${scoreCls}">${c.score}</span>
        <span class="cand-source">${escHtml(c.source_name)}</span>
        <span class="cand-time">${fmt(c.start)}–${fmt(c.end)}</span>
        ${details ? `<span class="cand-details">${escHtml(details)}</span>` : ''}
        <div class="cand-actions">
          <button class="cand-play-btn" onclick="playCandidateById(${g.group_id},${ci})">▶</button>
          <span class="trim-group" title="Trim start: remove audio from the beginning">
            <button class="trim-btn" onclick="trimCandidate(${g.group_id},${ci},'start',-1)" title="Restore 50ms at start">◂</button>
            <span class="trim-val" id="trim-start-val-${key}">${candTrims[key]?.startTrim ? candTrims[key].startTrim+'ms' : ''}</span>
            <button class="trim-btn trim-btn-cut" onclick="trimCandidate(${g.group_id},${ci},'start',+1)" title="Cut 50ms from start">⊣</button>
          </span>
          <span class="trim-group" title="Trim end: remove audio from the end">
            <button class="trim-btn trim-btn-cut" onclick="trimCandidate(${g.group_id},${ci},'end',+1)" title="Cut 50ms from end">⊢</button>
            <span class="trim-val" id="trim-end-val-${key}">${candTrims[key]?.endTrim ? candTrims[key].endTrim+'ms' : ''}</span>
            <button class="trim-btn" onclick="trimCandidate(${g.group_id},${ci},'end',-1)" title="Restore 50ms at end">▸</button>
          </span>
          ${hasDels ? `<button class="cand-restore-btn" onclick="restoreCandDels('${key}',${g.group_id})">Restore cuts</button>` : ''}
          <button class="cand-dup-btn" onclick="duplicateCandidate(${g.group_id},${ci})" title="Duplicate this line">⧉</button>
          <button class="cand-delete-btn" onclick="deleteCandidateFromGroup(${g.group_id},${ci})" title="Remove this candidate">×</button>
        </div>
      </div>
      <div class="cand-words" data-key="${key}">${wordsHtml}</div>
    </div>`;
  }).join('');

  const addedLabel = addedItem ? '✓ In Assembly' : '+ Add to Assembly';
  const addedCls   = addedItem ? 'group-add-btn added' : 'group-add-btn';

  return `<div class="group-card" id="gc-${g.group_id}" draggable="true"
      ondragstart="groupDragStart(event,${idx})"
      ondragover="groupDragOver(event)"
      ondrop="groupDrop(event,${idx})"
      ondragleave="groupDragLeave(event)">
    <div class="group-card-header">
      <span class="group-drag-handle" title="Drag to reorder">⠿</span>
      <span class="group-num">Group ${g.group_id + 1}</span>
      <div class="group-rating-btns">
        <button class="grb grb-good${groupRatings[g.group_id]==='good'?' grb-active':''}" onclick="setGroupRating(${g.group_id},'good')" title="Ready">●</button>
        <button class="grb grb-meh${groupRatings[g.group_id]==='meh'?' grb-active':''}"  onclick="setGroupRating(${g.group_id},'meh')"  title="Needs work">●</button>
        <button class="grb grb-bad${groupRatings[g.group_id]==='bad'?' grb-active':''}"  onclick="setGroupRating(${g.group_id},'bad')"  title="Skip">●</button>
      </div>
      <span class="group-preview">${escHtml(g.candidates[0]?.text || g.normalized_text)}</span>
      <button class="group-delete-btn" onclick="deleteGroup(${g.group_id})" title="Remove entire group">×</button>
    </div>
    ${candidatesHtml}
    <div class="group-footer">
      <button class="${addedCls}" onclick="addGroupToAssembly(${g.group_id})">${addedLabel}</button>
      ${addedItem ? `<button class="group-remove-btn" onclick="removeFromAssemblyByGroup(${g.group_id})">Remove</button>` : ''}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate word helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCandWords(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  const c = g?.candidates[ci];
  if (!c) return [];
  return (wordMaps[c.file_id] || []).filter(w => w.start >= c.start - 0.15 && w.end <= c.end + 0.15);
}

function isCandWordDeleted(key, w) {
  return (candDels[key] || []).some(d => d.globalIdx === w.globalIdx);
}

function restoreCandDels(key, groupId) {
  delete candDels[key];
  redrawGroupCard(groupId);
  toast('Word cuts restored');
}

function duplicateCandidate(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  if (!g) return;
  const copy = { ...g.candidates[ci] };
  // Shift candDels and candTrims keys above ci up by 1 to make room for the duplicate
  const oldTotal = g.candidates.length;
  for (let i = oldTotal - 1; i > ci; i--) {
    const k = `${groupId}_${i}`;
    if (candDels[k])   { candDels[`${groupId}_${i + 1}`]   = candDels[k];   delete candDels[k]; }
    if (candTrims[k])  { candTrims[`${groupId}_${i + 1}`]  = candTrims[k];  delete candTrims[k]; }
  }
  g.candidates.splice(ci + 1, 0, copy);
  // Copy deletions from original to the new duplicate slot (trims start fresh on the copy)
  const origKey = `${groupId}_${ci}`;
  if (candDels[origKey]) candDels[`${groupId}_${ci + 1}`] = JSON.parse(JSON.stringify(candDels[origKey]));
  redrawGroupCard(groupId);
}

function deleteCandidateFromGroup(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  if (!g) return;
  g.candidates.splice(ci, 1);
  // Shift candDels and candTrims keys: remove the deleted index, slide everything above it down by 1
  const oldTotal = g.candidates.length + 1;
  delete candDels[`${groupId}_${ci}`];
  delete candTrims[`${groupId}_${ci}`];
  for (let i = ci + 1; i < oldTotal; i++) {
    const k = `${groupId}_${i}`;
    if (candDels[k]) { candDels[`${groupId}_${i - 1}`] = candDels[k]; delete candDels[k]; }
    if (candTrims[k]) { candTrims[`${groupId}_${i - 1}`] = candTrims[k]; delete candTrims[k]; }
  }
  if (wordSel?.key?.startsWith(`${groupId}_`)) clearWordSel();
  if (g.candidates.length === 0) {
    deleteGroup(groupId);
    return;
  }
  redrawGroupCard(groupId);
  toast('Candidate removed');
}

function setGroupRating(groupId, rating) {
  // Toggle off if clicking the active rating again
  groupRatings[groupId] = (groupRatings[groupId] === rating) ? null : rating;
  const card = document.getElementById(`gc-${groupId}`);
  if (!card) return;
  ['good','meh','bad'].forEach(r => {
    card.querySelector(`.grb-${r}`)?.classList.toggle('grb-active', groupRatings[groupId] === r);
  });
  // Dim the card when rated bad, highlight when good
  card.classList.toggle('group-rated-good', groupRatings[groupId] === 'good');
  card.classList.toggle('group-rated-meh',  groupRatings[groupId] === 'meh');
  card.classList.toggle('group-rated-bad',  groupRatings[groupId] === 'bad');
}

function deleteGroup(groupId) {
  if (!groupResult) return;
  delete groupRatings[groupId];   // clean up rating — keyed by group_id, no index shift
  groupResult.groups = groupResult.groups.filter(g => g.group_id !== groupId);
  // Remove all assembly items from this group
  const before = assembly.length;
  for (let i = assembly.length - 1; i >= 0; i--)
    if (assembly[i].groupId === groupId) assembly.splice(i, 1);
  if (assembly.length < before) renderAssembly();
  // Clear selection if it was in this group
  if (wordSel?.key?.startsWith(`${groupId}_`)) clearWordSel();
  const el = document.getElementById(`gc-${groupId}`);
  if (el) el.remove();
  const n = groupResult.groups.length;
  document.getElementById('groups-stats').textContent = `${n} sentence group${n !== 1 ? 's' : ''}`;
  toast('Group removed');
}

function redrawGroupCard(groupId) {
  const el = document.getElementById(`gc-${groupId}`);
  if (!el || !groupResult) return;
  const g = groupResult.groups.find(g => g.group_id === groupId);
  if (g) el.outerHTML = renderGroupCard(g);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified word-click handler (candidates + assembly)
// ─────────────────────────────────────────────────────────────────────────────

function onWordClick(e) {
  const span = e.target.closest('[data-seltype]');
  if (!span || span.classList.contains('deleted')) return;

  const seltype = span.dataset.seltype;
  const key     = span.dataset.key;
  const lidx    = parseInt(span.dataset.lidx);

  if (e.shiftKey && wordSelAnchorKey === key && wordSelAnchorIdx !== null) {
    setWordSel(seltype, key, wordSelAnchorIdx, lidx);
  } else {
    wordSelAnchorKey = key;
    wordSelAnchorIdx = lidx;
    setWordSel(seltype, key, lidx, lidx);
  }
  e.preventDefault();
}

function setWordSel(seltype, key, from, to) {
  wordSel = { seltype, key, fromLocalIdx: Math.min(from, to), toLocalIdx: Math.max(from, to) };
  updateWordSelHighlight();
  showToolbar();
}

function updateWordSelHighlight() {
  document.querySelectorAll('.cand-word.selected, .asm-word.selected').forEach(el => el.classList.remove('selected'));
  if (!wordSel) return;
  const { key, fromLocalIdx, toLocalIdx } = wordSel;
  for (let i = fromLocalIdx; i <= toLocalIdx; i++) {
    const el = document.querySelector(`[data-seltype][data-key="${key}"][data-lidx="${i}"]`);
    if (el) el.classList.add('selected');
  }
}

function clearWordSel() {
  wordSel = null; wordSelAnchorKey = null; wordSelAnchorIdx = null;
  updateWordSelHighlight(); hideToolbar();
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────────────────────────

function showToolbar() {
  if (!wordSel) return;
  const words   = getWordSelWords().filter(w => !isWordSelDeleted(w));
  const preview = words.map(w => w.word).join(' ').slice(0, 65);
  document.getElementById('sel-label').textContent = `"${preview}${preview.length === 65 ? '…' : ''}"`;
  document.getElementById('selection-toolbar').style.display = 'flex';
}
function hideToolbar() { document.getElementById('selection-toolbar').style.display = 'none'; }

function getWordSelWords() {
  if (!wordSel) return [];
  const { seltype, key, fromLocalIdx, toLocalIdx } = wordSel;
  if (seltype === 'cand') {
    const [gid, ci] = key.split('_').map(Number);
    return getCandWords(gid, ci).slice(fromLocalIdx, toLocalIdx + 1);
  }
  const item = assembly.find(a => a.id === key);
  return item ? getAsmWords(item).slice(fromLocalIdx, toLocalIdx + 1) : [];
}

function isWordSelDeleted(w) {
  if (!wordSel) return false;
  const { seltype, key } = wordSel;
  if (seltype === 'cand') {
    return (candDels[key] || []).some(d => d.globalIdx === w.globalIdx);
  }
  // Assembly sgDels are time ranges (backend format) — use midpoint check there
  const mid  = (w.start + w.end) / 2;
  const dels = assembly.find(a => a.id === key)?.sgDels || [];
  return dels.some(d => mid >= d.start && mid <= d.end);
}

function playWordSel() {
  if (!wordSel) return;
  const allSel = getWordSelWords();
  const hasVisible = allSel.some(w => !isWordSelDeleted(w));
  if (!hasVisible) { toast('All selected words are deleted'); return; }
  const ranges = buildVisibleRanges(allSel, isWordSelDeleted);

  let fileId, label;
  if (wordSel.seltype === 'cand') {
    const [gid, ci] = wordSel.key.split('_').map(Number);
    const c = groupResult?.groups?.find(g => g.group_id === gid)?.candidates[ci];
    if (!c) return;
    fileId = c.file_id; label = `${c.source_name} · selection`;
  } else {
    const item = assembly.find(a => a.id === wordSel.key);
    if (!item) return;
    fileId = item.fileId; label = `${item.sourceName} · selection`;
  }
  playSegmentRanges(fileId, ranges, label);
}

function deleteWordSel() {
  if (!wordSel) return;
  const { seltype, key } = wordSel;
  const toDelete = getWordSelWords().filter(w => !isWordSelDeleted(w));
  if (!toDelete.length) { toast('Already deleted'); clearWordSel(); return; }

  if (seltype === 'cand') {
    if (!candDels[key]) candDels[key] = [];
    toDelete.forEach(w => {
      if (!candDels[key].some(d => d.globalIdx === w.globalIdx))
        candDels[key].push({ start: w.start, end: w.end, globalIdx: w.globalIdx });
    });
    const [gid] = key.split('_').map(Number);
    clearWordSel();
    redrawGroupCard(gid);
  } else {
    const item = assembly.find(a => a.id === key);
    if (!item) return;
    if (!item.sgDels) item.sgDels = [];
    toDelete.forEach(w => item.sgDels.push({ start: w.start, end: w.end }));
    item.sgDels = mergeDeletionRanges(item.sgDels);
    clearWordSel();
    renderAssembly();
  }
  toast(`Deleted ${toDelete.length} word(s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate play + add
// ─────────────────────────────────────────────────────────────────────────────

function trimCandidate(groupId, ci, side, direction) {
  // side: 'start'|'end'   direction: +1 (trim/cut) | -1 (extend/restore)
  // Values can be negative, meaning the range is extended PAST its original boundary.
  const key = `${groupId}_${ci}`;
  if (!candTrims[key]) candTrims[key] = { startTrim: 0, endTrim: 0 };
  const t = candTrims[key];
  const MAX_MS = 500;
  if (side === 'start') t.startTrim = Math.max(-MAX_MS, Math.min(MAX_MS, t.startTrim + direction * TRIM_STEP_MS));
  else                  t.endTrim   = Math.max(-MAX_MS, Math.min(MAX_MS, t.endTrim   + direction * TRIM_STEP_MS));

  // Re-render the trim indicator in place without full re-render
  const startEl = document.getElementById(`trim-start-val-${key}`);
  const endEl   = document.getElementById(`trim-end-val-${key}`);
  if (startEl) startEl.textContent = t.startTrim ? `${t.startTrim > 0 ? '+' : ''}${t.startTrim}ms` : '';
  if (endEl)   endEl.textContent   = t.endTrim   ? `${t.endTrim   > 0 ? '+' : ''}${t.endTrim}ms`   : '';

  // Auto-replay so user immediately hears the change
  playCandidateById(groupId, ci);
}

function playCandidateById(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  const c = g?.candidates[ci];
  if (!c) return;
  const key      = `${groupId}_${ci}`;
  const allWords = getCandWords(groupId, ci);
  const hasDels  = (candDels[key] || []).length > 0;

  let ranges;
  if (!hasDels) {
    // No deletions: use the backend-computed ranges which incorporate the zero-gap
    // boundary offset (avoids acoustic bleed from the previous segment).
    ranges = c.ranges || [{ start: c.start, end: c.end }];
  } else {
    ranges = buildVisibleRanges(allWords, w => isCandWordDeleted(key, w));
    // If words were deleted from the start, the new first word's timestamp has
    // acoustic bleed from the last deleted word. Skip 100ms past the boundary.
    if (ranges.length > 0 && allWords.length > 0 && isCandWordDeleted(key, allWords[0])) {
      const firstVisibleDur = ranges[0].end - ranges[0].start;
      const skip = Math.min(0.10, firstVisibleDur * 0.40);
      ranges = [{ start: ranges[0].start + skip, end: ranges[0].end }, ...ranges.slice(1)];
    }
  }

  // Pass word-boundary anchors so trim=0 snaps to the actual word edge, not EDGE_BUF-padded range edge
  const visibleWords = allWords.filter(w => !isCandWordDeleted(key, w));
  const wordStart = visibleWords[0]?.start;
  const wordEnd   = visibleWords[visibleWords.length - 1]?.end;
  ranges = applyTrims(ranges, key, wordStart, wordEnd);
  playSegmentRanges(c.file_id, ranges, `${c.source_name} · ${fmt(c.start)}–${fmt(c.end)}`);
}

// "Add to Assembly" for a group — combines visible words from all candidates
// in rank order. If multiple candidates have visible words, a composite item
// is created that exports as seamlessly joined parts. If only one candidate
// has visible words, a normal single-source item is created.
function addGroupToAssembly(groupId) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  if (!g?.candidates.length) return;

  // Each candidate becomes its own assembly item (separate sentence).
  // Word cuts (sgDels) are preserved per item so the user can edit further in assembly.
  // To exclude a candidate entirely, delete it with × before adding.
  const newItems = [];
  for (let ci = 0; ci < g.candidates.length; ci++) {
    const c        = g.candidates[ci];
    const key      = `${groupId}_${ci}`;
    const allWords = getCandWords(groupId, ci);
    const hasDels  = (candDels[key] || []).length > 0;
    const baseRanges = c.ranges?.length ? c.ranges : null;

    let visibleRanges;
    if (hasDels) {
      // User made explicit word cuts — word selection defines the audio exactly.
      // Do NOT intersect with dead-zone ranges (would produce tiny fragments).
      visibleRanges = buildVisibleRanges(allWords, w => isCandWordDeleted(key, w));
      if (!visibleRanges.length) visibleRanges = baseRanges || [{ start: c.start, end: c.end }];
    } else {
      // No cuts — use backend-computed ranges which already skip dead zones.
      visibleRanges = baseRanges || (allWords.length
        ? buildVisibleRanges(allWords, () => false)
        : [{ start: c.start, end: c.end }]);
    }
    if (!visibleRanges.length) continue;

    const visible = allWords.filter(w => !isCandWordDeleted(key, w));

    // Apply manual trim offsets anchored to word boundaries
    const trimWordStart = visible[0]?.start;
    const trimWordEnd   = visible[visible.length - 1]?.end;
    visibleRanges = applyTrims(visibleRanges, key, trimWordStart, trimWordEnd);

    const sgDels  = mergeDeletionRanges((candDels[key] || []).map(d => ({start: d.start, end: d.end})));
    // start/end: for cut candidates use visible-word bounds (so getAsmWords is scoped
    // correctly); for unmodified candidates use full candidate range so the backend
    // receives the complete audio — dead-zone ranges are for preview only.
    const itemStart = hasDels ? visibleRanges[0].start : c.start;
    const itemEnd   = hasDels ? visibleRanges[visibleRanges.length - 1].end : c.end;
    newItems.push({
      id: uid(), groupId, fileId: c.file_id, sourceName: c.source_name,
      text: visible.length ? visible.map(w => w.word).join(' ') : c.text,
      start: itemStart, end: itemEnd, sgDels,
      exportRanges: visibleRanges,  // stored at creation time from correct words
    });
  }

  if (!newItems.length) return;

  // Replace any existing items for this group, preserving their position in the assembly.
  const existingFirst = assembly.findIndex(a => a.groupId === groupId);
  if (existingFirst >= 0) {
    const oldCount = assembly.filter(a => a.groupId === groupId).length;
    assembly.splice(existingFirst, oldCount, ...newItems);
  } else {
    const groupOrder = groupResult.groups.map(g => g.group_id);
    const prevGid = groupOrder.slice(0, groupOrder.indexOf(groupId)).reverse()
      .find(gid => assembly.some(a => a.groupId === gid));
    const insertAfter = prevGid !== undefined
      ? assembly.findLastIndex(a => a.groupId === prevGid)
      : -1;
    assembly.splice(insertAfter + 1, 0, ...newItems);
  }

  clearWordSel();
  renderAssembly();
  redrawGroupCard(groupId);
  toast(`Added ${newItems.length} line${newItems.length > 1 ? 's' : ''} to assembly`);
}

let candDragSrc = null; // {groupId, ci}
function candDragStart(e, groupId, ci) {
  candDragSrc = { groupId, ci };
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
}
function candDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}
function candDrop(e, groupId, ci) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (!candDragSrc || candDragSrc.groupId !== groupId || candDragSrc.ci === ci) {
    candDragSrc = null; return;
  }
  const g = groupResult?.groups?.find(gr => gr.group_id === groupId);
  if (!g) { candDragSrc = null; return; }
  const fromCi = candDragSrc.ci;
  candDragSrc = null;

  // Snapshot deletions keyed by candidate object identity before any splice
  const delsByRef = new Map();
  g.candidates.forEach((c, i) => {
    const k = `${groupId}_${i}`;
    if (candDels[k]) delsByRef.set(c, candDels[k]);
    delete candDels[k];
  });

  // Perform the move
  const [moved] = g.candidates.splice(fromCi, 1);
  g.candidates.splice(ci, 0, moved);

  // Re-assign deletions using the same object references (no index math needed)
  g.candidates.forEach((c, newI) => {
    if (delsByRef.has(c)) candDels[`${groupId}_${newI}`] = delsByRef.get(c);
  });

  redrawGroupCard(groupId);
}

function groupDragStart(e, idx) {
  groupDragSrcIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.stopPropagation();
}
function groupDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function groupDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function groupDrop(e, idx) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (groupDragSrcIdx === null || groupDragSrcIdx === idx) { groupDragSrcIdx = null; return; }
  const moved = groupResult.groups.splice(groupDragSrcIdx, 1)[0];
  groupResult.groups.splice(idx, 0, moved);
  groupDragSrcIdx = null;
  renderGroups();
}

function addAllToAssembly() {
  if (!groupResult?.groups?.length) return;
  let added = 0;
  for (const g of groupResult.groups) {
    if (assembly.some(a => a.groupId === g.group_id)) continue;
    if (!g.candidates.length) continue;
    // Skip fragments — top candidate must have at least 3 words
    const topWords = (g.candidates[0]?.text || '').trim().split(/\s+/).filter(w => w.length > 0);
    if (topWords.length <= 2) continue;
    addGroupToAssembly(g.group_id);
    added++;
  }
  toast(added > 0 ? `Added ${added} group${added !== 1 ? 's' : ''} to assembly` : 'All groups already in assembly (or only fragments remain)');
}

// Clip wordRanges to only the portions that fall inside baseRanges (dead-zone-aware).
// This prevents a single word-range from spanning across a dead zone.
function intersectRangeLists(wordRanges, baseRanges) {
  if (!baseRanges?.length) return wordRanges;
  const result = [];
  for (const wr of wordRanges) {
    for (const br of baseRanges) {
      const s = Math.max(wr.start, br.start);
      const e = Math.min(wr.end,   br.end);
      if (s < e) result.push({ start: s, end: e });
    }
  }
  return result.length ? result : wordRanges;
}

function removeFromAssemblyByGroup(groupId) {
  const before = assembly.length;
  for (let i = assembly.length - 1; i >= 0; i--)
    if (assembly[i].groupId === groupId) assembly.splice(i, 1);
  if (assembly.length < before) { renderAssembly(); redrawGroupCard(groupId); toast('Removed from assembly'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

function getAsmWords(item) {
  return (wordMaps[item.fileId] || []).filter(w => w.start >= item.start - 0.15 && w.end <= item.end + 0.15);
}

function isAsmWordDeleted(item, w) {
  const mid = (w.start + w.end) / 2;
  return (item.sgDels || []).some(d => mid >= d.start && mid <= d.end);
}

// Walk all words in order; create a hard cut wherever a deleted word appears.
// This prevents deleted words' audio from bleeding into adjacent visible ranges.
function buildVisibleRanges(allWords, isDeletedFn) {
  const ranges = [];
  let cur = null;
  for (const w of allWords) {
    if (isDeletedFn(w)) {
      if (cur) { ranges.push(cur); cur = null; }
    } else {
      if (!cur) cur = { start: w.start, end: w.end };
      else cur.end = w.end;
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

// Apply candTrims offsets to a ranges array.
// Anchors trims to the first/last WORD boundary (not the range edge which includes
// backend EDGE_BUF padding) so the first click is always immediately audible.
// wordStart / wordEnd are the actual word timestamps; if omitted, falls back to range edges.
function applyTrims(ranges, key, wordStart, wordEnd) {
  if (!ranges?.length) return ranges;
  const t = candTrims[key];
  if (!t || (t.startTrim === 0 && t.endTrim === 0)) return ranges;
  const out = ranges.map(r => ({ ...r }));
  // Use word boundary as anchor so trim=0 = word edge, trim>0 = cut into word, trim<0 = extend past
  if (t.startTrim !== 0) {
    const anchor = (wordStart != null) ? wordStart : out[0].start;
    out[0].start = Math.max(0, anchor + t.startTrim / 1000);
  }
  if (t.endTrim !== 0) {
    const anchor = (wordEnd != null) ? wordEnd : out[out.length - 1].end;
    out[out.length - 1].end = anchor - t.endTrim / 1000;
  }
  // Guard: don't let a range collapse
  out[0].start = Math.min(out[0].start, out[0].end - 0.01);
  out[out.length - 1].end = Math.max(out[out.length - 1].end, out[out.length - 1].start + 0.01);
  return out;
}

function getAsmItemRanges(item) {
  // Use ranges stored at assembly-creation time (computed from correct words).
  if (item.exportRanges?.length) return item.exportRanges;

  // Fallback for items without stored ranges.
  return [{ start: item.start, end: item.end }];
}

function renderAssembly() {
  const list   = document.getElementById('assembly-list');
  const btnExp = document.getElementById('btn-export');
  if (!assembly.length) {
    list.innerHTML = '<div class="assembly-empty">No sentences added yet — pick candidates above.</div>';
    btnExp.disabled = true; return;
  }
  btnExp.disabled = false;
  list.innerHTML = assembly.map((item, i) => renderAsmItem(item, i)).join('');
}

function renderAsmItemComposite(item, i) {
  const dur = item.parts.reduce((s, p) =>
    s + p.ranges.reduce((rs, r) => rs + (r.end - r.start), 0), 0);

  const partsHtml = item.parts.map((p, pi) => {
    const allWords = (wordMaps[p.fileId] || []).filter(w =>
      p.ranges.some(r => w.start >= r.start - 0.15 && w.end <= r.end + 0.15));
    const wordsHtml = allWords.length
      ? allWords.map(w => `<span class="asm-word">${escHtml(w.word)}</span>`).join(' ')
      : p.ranges.map(r => `${fmt(r.start)}–${fmt(r.end)}`).join(', ');
    const sep = pi > 0
      ? `<span class="asm-composite-sep" title="${escHtml(p.sourceName)}">↗</span> `
      : '';
    return sep + wordsHtml;
  }).join(' ');

  const sourceLabel = [...new Set(item.parts.map(p => p.sourceName))].join(' + ');
  return `<div class="asm-item asm-composite" id="ai-${item.id}">
    <div class="asm-item-header">
      <span class="asm-num">${i + 1}</span>
      <span class="asm-source" title="${escHtml(sourceLabel)}">⊕ ${escHtml(sourceLabel)}</span>
      <span class="asm-time">${fmtDur(dur)}</span>
    </div>
    <div class="asm-words">${partsHtml}</div>
  </div>`;
}

function renderAsmItem(item, i) {
  if (item.composite) return renderAsmItemComposite(item, i);

  const words = getAsmWords(item).filter(w => !isAsmWordDeleted(item, w));
  const ranges = getAsmItemRanges(item);
  const dur    = ranges.reduce((s, r) => s + (r.end - r.start), 0);

  const wordsHtml = words.length
    ? words.map(w => `<span class="asm-word">${escHtml(w.word)}</span>`).join(' ')
    : `<span class="asm-word-plain">${escHtml(item.text)}</span>`;

  return `<div class="asm-item" id="ai-${item.id}">
    <div class="asm-item-header">
      <span class="asm-num">${i + 1}</span>
      <span class="asm-source" title="${escHtml(item.sourceName)}">${escHtml(item.sourceName)}</span>
      <span class="asm-time">${fmt(item.start)}–${fmt(item.end)} · ${fmtDur(dur)}</span>
    </div>
    <div class="asm-words">${wordsHtml}</div>
  </div>`;
}

function playAsmItem(itemId) {
  const item = assembly.find(a => a.id === itemId);
  if (!item) return;
  if (item.composite) {
    // Play each part sequentially
    let pi = 0;
    const playNext = () => {
      if (pi >= item.parts.length) return;
      const part = item.parts[pi++];
      const label = `${part.sourceName} (${pi}/${item.parts.length})`;
      playSegmentRanges(part.fileId, part.ranges, label, playNext);
    };
    playNext();
    return;
  }
  const hasDels = (item.sgDels || []).length > 0;
  const ranges = hasDels
    ? buildVisibleRanges(getAsmWords(item), w => isAsmWordDeleted(item, w))
    : getAsmItemRanges(item);
  if (!ranges.length) { toast('All words deleted'); return; }
  playSegmentRanges(item.fileId, ranges, `${item.sourceName} · ${fmt(item.start)}–${fmt(item.end)}`);
}

function removeAsmItem(itemId) {
  const gid = assembly.find(a => a.id === itemId)?.groupId;
  assembly.splice(assembly.findIndex(a => a.id === itemId), 1);
  if (wordSel?.key === itemId) clearWordSel();
  renderAssembly();
  if (gid != null) redrawGroupCard(gid);
}

function restoreAsmDels(itemId) {
  const item = assembly.find(a => a.id === itemId);
  if (item) { item.sgDels = []; renderAssembly(); toast('Word deletions restored'); }
}

function clearAssembly() {
  if (assembly.length && !confirm('Clear all assembly items?')) return;
  assembly = []; clearWordSel(); renderAssembly();
  groupResult?.groups?.forEach(g => redrawGroupCard(g.group_id));
}

function asmDragStart(e, i) { asmDragSrcIdx = i; e.dataTransfer.effectAllowed = 'move'; }
function asmDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function asmDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function asmDrop(e, i) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (asmDragSrcIdx === null || asmDragSrcIdx === i) { asmDragSrcIdx = null; return; }
  const moved = assembly.splice(asmDragSrcIdx, 1)[0];
  assembly.splice(i, 0, moved);
  asmDragSrcIdx = null;
  renderAssembly();
}

async function exportAssembly() {
  if (!assembly.length) return;
  toast('Exporting…');
  const clips = [];
  for (let i = 0; i < assembly.length; i++) {
    const item = assembly[i];
    const prev = assembly[i - 1];
    // Same group = parts of the same sentence → join seamlessly (no sentence gap).
    const no_gap_before = prev != null && prev.groupId === item.groupId;
    if (item.composite) {
      const compositeText = item.parts.map(p => p.text || '').join(' ').trim();
      item.parts.forEach((p, pi) => {
        clips.push({
          file_id: p.fileId, ranges: p.ranges,
          no_gap_before: pi > 0 || no_gap_before,
          subtitle_text: pi === 0 ? compositeText : null,
        });
      });
    } else {
      clips.push({ file_id: item.fileId, ranges: getAsmItemRanges(item), no_gap_before, subtitle_text: item.text || '' });
    }
  }
  try {
    const r = await fetch(`${API}/session/${currentSession}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips }),
    });
    if (!r.ok) { toast('Export failed'); return; }
    const data = await r.json();
    const a = document.createElement('a');
    a.href = `${API}/export/${data.filename}`; a.download = data.filename;
    document.body.appendChild(a); a.click(); a.remove();
    toast('Exported: ' + data.filename);
  } catch (e) { toast('Export error: ' + e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Precise segment playback — AudioBufferSourceNode for sample-accurate control
// ─────────────────────────────────────────────────────────────────────────────

function playSegmentRanges(fileId, ranges, label, onComplete = null) {
  if (!ranges?.length) return;

  if (rangePlayer) { rangePlayer.cancel(); rangePlayer = null; }

  const bar    = document.getElementById('global-audio-bar');
  const nlabel = document.getElementById('now-playing-label');
  bar.style.display = 'flex';
  nlabel.textContent = label;

  _loadAudioBuffer(fileId).then(audioBuf => {
    if (rangePlayer && rangePlayer._cancelled) return;

    const cancelFn = _playRanges(audioBuf, ranges, () => {
      rangePlayer = null;
      if (onComplete) onComplete();
    });

    rangePlayer = {
      _cancelled: false,
      cancel() {
        this._cancelled = true;
        cancelFn();
      }
    };
  }).catch(err => {
    console.error('[playSegmentRanges] failed to load audio buffer:', err);
    rangePlayer = null;
  });

  // Set a placeholder so cancel works even before the buffer resolves
  if (!rangePlayer) {
    rangePlayer = { _cancelled: false, cancel() { this._cancelled = true; } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini player (takes panel)
// ─────────────────────────────────────────────────────────────────────────────

function toggleMiniPlay(fid, src) {
  let audio = miniAudios[fid];
  const btn = document.getElementById(`mpbtn-${fid}`);
  if (!audio) {
    audio = new Audio(src); miniAudios[fid] = audio;
    audio.addEventListener('timeupdate', () => {
      const fill = document.getElementById(`pb-${fid}`);
      const lbl  = document.getElementById(`tl-${fid}`);
      if (fill && audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      if (lbl) lbl.textContent = fmt(audio.currentTime);
    });
    audio.addEventListener('ended', () => { if (btn) btn.textContent = '▶'; });
  }
  if (audio.paused) {
    Object.entries(miniAudios).forEach(([id, a]) => {
      if (id !== fid && !a.paused) { a.pause(); const ob = document.getElementById(`mpbtn-${id}`); if (ob) ob.textContent = '▶'; }
    });
    audio.play(); if (btn) btn.textContent = '⏸';
  } else { audio.pause(); if (btn) btn.textContent = '▶'; }
}

function seekMini(e, fid) {
  const audio = miniAudios[fid];
  if (!audio?.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function mergeWordRanges(words, maxGap = 0.15) {
  if (!words.length) return [];
  let cur = { start: words[0].start, end: words[0].end };
  const out = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i].start - cur.end <= maxGap) cur.end = words[i].end;
    else { out.push(cur); cur = { start: words[i].start, end: words[i].end }; }
  }
  out.push(cur);
  return out;
}

function mergeDeletionRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.05) last.end = Math.max(last.end, sorted[i].end);
    else merged.push({ ...sorted[i] });
  }
  return merged;
}

function fmt(s) {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60).toString().padStart(2, '0'), ms = Math.floor((s % 1) * 10);
  return `${m}:${sec}.${ms}`;
}
function fmtDur(s) { return !s ? '' : s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s/60)}m${Math.floor(s%60)}s`; }
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function uid() { return Math.random().toString(36).slice(2, 9); }

let _toastTimer = null;
function toast(msg) {
  const el = document.getElementById('status-toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
