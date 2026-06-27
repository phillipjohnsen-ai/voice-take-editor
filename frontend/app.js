// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const API = 'http://127.0.0.1:8765/api';
let currentSession = null;

// wordMaps[fileId] = [{word, start, end, segId, globalIdx}]
const wordMaps = {};

// Take-level deletions (takes panel)
const deletions = {};

// Take-panel word selection (mousedown-drag in takes grid)
let takesSel = null;
let takesSelecting = false, takesSelFid = null, takesSelAnchor = null;

// ── Sentence groups ──────────────────────────────────────────────────────────
let groupResult = null;

// Per-candidate word deletions  key = `${groupId}_${ci}`
const candDels = {};
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
  document.getElementById('btn-transcribe-all').addEventListener('click', transcribeAll);
  document.getElementById('btn-remove-silence-all').addEventListener('click', removeSilenceAll);
  document.getElementById('show-processed').addEventListener('change', refreshTakes);
  document.getElementById('btn-group-rank').addEventListener('click', runGroupRank);
  document.getElementById('btn-regroup').addEventListener('click', runGroupRank);
  document.getElementById('btn-clear-assembly').addEventListener('click', clearAssembly);
  document.getElementById('btn-export').addEventListener('click', exportAssembly);

  // Toolbar
  document.getElementById('btn-sel-play').addEventListener('click', playWordSel);
  document.getElementById('btn-sel-delete').addEventListener('click', deleteWordSel);
  document.getElementById('btn-sel-clear').addEventListener('click', clearWordSel);

  // Word clicks delegated per section
  document.getElementById('groups-list').addEventListener('click', onWordClick);
  document.getElementById('assembly-list').addEventListener('click', onWordClick);

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
  [wordMaps, deletions, candDels].forEach(o => Object.keys(o).forEach(k => delete o[k]));
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
  toast(`Removing silence from ${Object.keys(s.files || {}).length} file(s)…`);
  for (const fid of Object.keys(s.files || {}))
    fetch(`${API}/session/${currentSession}/remove_silence/${fid}`, { method: 'POST' });
}
async function removeSilenceOne(fid) {
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
    document.getElementById('btn-group-rank').disabled = done < 1;
  } catch (_) {}
}

function renderTakes(files) {
  const grid = document.getElementById('takes-grid');
  const useProcessed = document.getElementById('show-processed').checked;
  for (const [fid, fdata] of Object.entries(files)) {
    if (fdata.status === 'done' && fdata.segments?.length && !wordMaps[fid])
      buildWordMap(fid, fdata.segments);
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
    </div>
    <div class="take-card-actions">
      ${fdata.status !== 'transcribing' ? `<button class="ghost" onclick="transcribeOne('${fid}')">Transcribe</button>` : ''}
      ${!fdata.silence_removed ? `<button class="ghost" onclick="removeSilenceOne('${fid}')">Remove Silence</button>` : ''}
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
        const isDel = dels.some(d => mid >= d.start && mid <= d.end);
        const isSel = wordSel?.key === key && li >= wordSel.fromLocalIdx && li <= wordSel.toLocalIdx;
        const cls  = ['cand-word', isDel ? 'deleted' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
        return `<span class="${cls}" data-seltype="cand" data-key="${key}" data-gid="${g.group_id}" data-ci="${ci}" data-fid="${c.file_id}" data-lidx="${li}" data-start="${w.start}" data-end="${w.end}">${escHtml(w.word)}</span>`;
      }).join(' ');
    } else {
      wordsHtml = `<span class="cand-word-plain">${escHtml(c.text)}</span>`;
    }

    return `<div class="candidate-row" id="cand-${key}">
      <div class="cand-header">
        <span class="cand-rank">#${ci + 1}</span>
        <span class="cand-score ${scoreCls}">${c.score}</span>
        <span class="cand-source">${escHtml(c.source_name)}</span>
        <span class="cand-time">${fmt(c.start)}–${fmt(c.end)}</span>
        ${details ? `<span class="cand-details">${escHtml(details)}</span>` : ''}
        <div class="cand-actions">
          <button class="cand-play-btn" onclick="playCandidateById(${g.group_id},${ci})">▶</button>
          ${hasDels ? `<button class="cand-restore-btn" onclick="restoreCandDels('${key}',${g.group_id})">Restore cuts</button>` : ''}
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
  return (wordMaps[c.file_id] || []).filter(w => w.start >= c.start - 0.05 && w.end <= c.end + 0.05);
}

function isCandWordDeleted(key, w) {
  const mid = (w.start + w.end) / 2;
  return (candDels[key] || []).some(d => mid >= d.start && mid <= d.end);
}

function restoreCandDels(key, groupId) {
  delete candDels[key];
  redrawGroupCard(groupId);
  toast('Word cuts restored');
}

function deleteCandidateFromGroup(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  if (!g) return;
  g.candidates.splice(ci, 1);
  delete candDels[`${groupId}_${ci}`];
  if (wordSel?.key?.startsWith(`${groupId}_${ci}`)) clearWordSel();
  redrawGroupCard(groupId);
  toast('Candidate removed');
}

function deleteGroup(groupId) {
  if (!groupResult) return;
  groupResult.groups = groupResult.groups.filter(g => g.group_id !== groupId);
  // Remove any assembly item from this group
  const idx = assembly.findIndex(a => a.groupId === groupId);
  if (idx >= 0) { assembly.splice(idx, 1); renderAssembly(); }
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
  const mid  = (w.start + w.end) / 2;
  const dels = seltype === 'cand'
    ? (candDels[key] || [])
    : (assembly.find(a => a.id === key)?.sgDels || []);
  return dels.some(d => mid >= d.start && mid <= d.end);
}

function playWordSel() {
  if (!wordSel) return;
  const visible = getWordSelWords().filter(w => !isWordSelDeleted(w));
  if (!visible.length) { toast('All selected words are deleted'); return; }
  const ranges = mergeWordRanges(visible);

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
    toDelete.forEach(w => candDels[key].push({ start: w.start, end: w.end }));
    candDels[key] = mergeDeletionRanges(candDels[key]);
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

function playCandidateById(groupId, ci) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  const c = g?.candidates[ci];
  if (!c) return;
  const key      = `${groupId}_${ci}`;
  const segWords = getCandWords(groupId, ci);
  const visible  = segWords.filter(w => !isCandWordDeleted(key, w));
  const ranges   = visible.length ? mergeWordRanges(visible) : [{ start: c.start, end: c.end }];
  playSegmentRanges(c.file_id, ranges, `${c.source_name} · ${fmt(c.start)}–${fmt(c.end)}`);
}

// "Add to Assembly" for a group — uses whichever candidate the user last
// interacted with (has active wordSel or has deletions), else rank #1.
function addGroupToAssembly(groupId) {
  const g = groupResult?.groups?.find(g => g.group_id === groupId);
  if (!g?.candidates.length) return;

  // Pick candidate: prefer one with active selection in this group, then one with edits
  let ci = 0;
  if (wordSel?.seltype === 'cand') {
    const [gid, selCi] = wordSel.key.split('_').map(Number);
    if (gid === groupId) ci = selCi;
  }
  if (ci === 0) {
    for (let i = 0; i < g.candidates.length; i++) {
      if ((candDels[`${groupId}_${i}`] || []).length) { ci = i; break; }
    }
  }

  const c      = g.candidates[ci];
  const key    = `${groupId}_${ci}`;
  const visible = getCandWords(groupId, ci).filter(w => !isCandWordDeleted(key, w));
  const sgDels  = mergeDeletionRanges([...(candDels[key] || [])]);
  const item    = {
    id: uid(), groupId, fileId: c.file_id, sourceName: c.source_name,
    text: visible.length ? visible.map(w => w.word).join(' ') : c.text,
    start: c.start, end: c.end, sgDels,
  };

  const existingIdx = assembly.findIndex(a => a.groupId === groupId);
  if (existingIdx >= 0) {
    assembly[existingIdx] = item;
  } else {
    // Insert in group order
    const groupOrder = groupResult.groups.map(g => g.group_id);
    const prevGid    = groupOrder.slice(0, groupOrder.indexOf(groupId)).reverse()
      .find(gid => assembly.some(a => a.groupId === gid));
    const insertAfter = prevGid !== undefined
      ? assembly.findLastIndex(a => a.groupId === prevGid)
      : -1;
    assembly.splice(insertAfter + 1, 0, item);
  }

  clearWordSel();
  renderAssembly();
  redrawGroupCard(groupId);
  toast(`Added to assembly (candidate #${ci + 1}): ${c.source_name}`);
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
    if (assembly.some(a => a.groupId === g.group_id)) continue; // already in assembly
    if (!g.candidates.length) continue;
    addGroupToAssembly(g.group_id);
    added++;
  }
  toast(added > 0 ? `Added ${added} group${added !== 1 ? 's' : ''} to assembly` : 'All groups already in assembly');
}

function removeFromAssemblyByGroup(groupId) {
  const idx = assembly.findIndex(a => a.groupId === groupId);
  if (idx >= 0) assembly.splice(idx, 1);
  renderAssembly();
  redrawGroupCard(groupId);
  toast('Removed from assembly');
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

function getAsmWords(item) {
  return (wordMaps[item.fileId] || []).filter(w => w.start >= item.start - 0.05 && w.end <= item.end + 0.05);
}

function isAsmWordDeleted(item, w) {
  const mid = (w.start + w.end) / 2;
  return (item.sgDels || []).some(d => mid >= d.start && mid <= d.end);
}

function getAsmItemRanges(item) {
  const visible = getAsmWords(item).filter(w => !isAsmWordDeleted(item, w));
  if (!visible.length) return [{ start: item.start, end: item.end }];
  return mergeWordRanges(visible);
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

function renderAsmItem(item, i) {
  const words   = getAsmWords(item);
  const hasDels = (item.sgDels || []).length > 0;
  const ranges  = getAsmItemRanges(item);
  const dur     = ranges.reduce((s, r) => s + (r.end - r.start), 0);

  let wordsHtml;
  if (words.length) {
    wordsHtml = words.map((w, li) => {
      const isDel = isAsmWordDeleted(item, w);
      const isSel = wordSel?.key === item.id && li >= wordSel.fromLocalIdx && li <= wordSel.toLocalIdx;
      const cls = ['asm-word', isDel ? 'deleted' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-seltype="asm" data-key="${item.id}" data-lidx="${li}" data-start="${w.start}" data-end="${w.end}">${escHtml(w.word)}</span>`;
    }).join(' ');
  } else {
    wordsHtml = `<span class="asm-word-plain">${escHtml(item.text)}</span>`;
  }

  return `<div class="asm-item" id="ai-${item.id}" draggable="true"
      ondragstart="asmDragStart(event,${i})"
      ondragover="asmDragOver(event)"
      ondrop="asmDrop(event,${i})"
      ondragleave="asmDragLeave(event)">
    <div class="asm-item-header">
      <span class="asm-drag-handle">⠿</span>
      <span class="asm-num">${i + 1}</span>
      <span class="asm-source" title="${escHtml(item.sourceName)}">${escHtml(item.sourceName)}</span>
      <span class="asm-time">${fmt(item.start)}–${fmt(item.end)} · ${fmtDur(dur)}</span>
      <div class="asm-header-actions">
        <button class="asm-play-btn" onclick="playAsmItem('${item.id}')">▶</button>
        <button class="asm-remove-btn" onclick="removeAsmItem('${item.id}')">×</button>
      </div>
    </div>
    <div class="asm-words" id="aw-${item.id}">${wordsHtml}</div>
    ${hasDels ? `<button class="asm-restore-btn" onclick="restoreAsmDels('${item.id}')">Restore deleted words</button>` : ''}
  </div>`;
}

function playAsmItem(itemId) {
  const item = assembly.find(a => a.id === itemId);
  if (!item) return;
  const ranges = getAsmItemRanges(item);
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
  const clips = assembly.map(item => ({ file_id: item.fileId, use_processed: false, ranges: getAsmItemRanges(item) }));
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
// Precise segment playback  — setTimeout-based, stops exactly at range end
// ─────────────────────────────────────────────────────────────────────────────

function playSegmentRanges(fileId, ranges, label) {
  if (!ranges?.length) return;

  if (rangePlayer) { rangePlayer.cancel(); rangePlayer = null; }

  const audio  = document.getElementById('global-audio');
  const bar    = document.getElementById('global-audio-bar');
  const nlabel = document.getElementById('now-playing-label');
  bar.style.display = 'flex';
  nlabel.textContent = label;

  let cancelled = false;
  let stopTimer = null;

  rangePlayer = {
    cancel() {
      cancelled = true;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      audio.ontimeupdate = null;
      audio.pause();
    }
  };

  const playRange = (ri) => {
    if (cancelled || ri >= ranges.length) { rangePlayer = null; return; }
    const r = ranges[ri];

    audio.currentTime = r.start;
    audio.play().catch(() => {});

    // Schedule stop slightly early, then fine-tune with timeupdate for precision
    const durMs = Math.max(0, (r.end - r.start) * 1000 - 40);
    stopTimer = setTimeout(() => {
      if (cancelled) return;
      const done = () => {
        audio.pause();
        audio.ontimeupdate = null;
        stopTimer = null;
        if (!cancelled) {
          if (ri + 1 < ranges.length) setTimeout(() => playRange(ri + 1), 15);
          else rangePlayer = null;
        }
      };
      if (audio.currentTime < r.end) {
        // Spin until we hit or pass the end timestamp
        audio.ontimeupdate = () => { if (audio.currentTime >= r.end) done(); };
      } else {
        done();
      }
    }, durMs);
  };

  const targetSrc = `${API}/audio/${currentSession}/${fileId}`;
  if (audio.src === targetSrc) {
    playRange(0);
  } else {
    audio.src = targetSrc;
    audio.onloadedmetadata = () => { audio.onloadedmetadata = null; if (!cancelled) playRange(0); };
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
