import os
import re
import json
import uuid
import shutil
import subprocess
import tempfile
from difflib import SequenceMatcher
from pathlib import Path
from typing import List

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import aiofiles
import uvicorn

BASE_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
EXPORTS_DIR = BASE_DIR / "exports"
BINS_DIR = BASE_DIR / "bins"
FRONTEND_DIR = BASE_DIR / "frontend"
STATE_FILE = BASE_DIR / "state.json"

UPLOADS_DIR.mkdir(exist_ok=True)
EXPORTS_DIR.mkdir(exist_ok=True)

# ── FFmpeg / pydub setup ─────────────────────────────────────────────────────

def find_ffmpeg():
    local = BINS_DIR / "ffmpeg"
    if local.exists():
        return str(local)
    system = shutil.which("ffmpeg")
    if system:
        return system
    raise RuntimeError("ffmpeg not found. Run setup.sh first.")

def _setup_pydub(ffmpeg_path: str):
    """Point pydub at our local ffmpeg binary."""
    import pydub
    pydub.AudioSegment.converter = ffmpeg_path
    ffprobe = str(Path(ffmpeg_path).parent / "ffprobe")
    if Path(ffprobe).exists():
        pydub.AudioSegment.ffprobe = ffprobe
    ffmpeg_dir = str(Path(ffmpeg_path).parent)
    if ffmpeg_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

# Whisper model cached across requests (large → medium fallback)
_whisper_model = None

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    # stable_whisper is a drop-in replacement for whisper that produces significantly
    # more accurate word-level timestamps by refining them via direct audio analysis
    # after the initial CTC pass. This fixes compressed/shifted word boundaries.
    try:
        import stable_whisper as whisper_lib
    except ImportError:
        import whisper as whisper_lib
    for name in ("large", "medium"):
        try:
            print(f"Loading Whisper '{name}' model — first run downloads the model file "
                  f"({'~1.5 GB' if name == 'large' else '~769 MB'}), please wait…")
            _whisper_model = whisper_lib.load_model(name)
            print(f"Whisper '{name}' model loaded.")
            return _whisper_model
        except Exception as e:
            print(f"Could not load Whisper '{name}': {e} — trying next")
    raise RuntimeError("Could not load Whisper large or medium model.")

# ── State ────────────────────────────────────────────────────────────────────

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            st = json.load(f)
    else:
        st = {"sessions": {}}
    # Reset any files stuck in "transcribing" — background tasks don't survive
    # a server restart so these would be frozen forever without this recovery.
    recovered = 0
    for sess in st.get("sessions", {}).values():
        for fdata in sess.get("files", {}).values():
            if fdata.get("status") == "transcribing":
                fdata["status"] = "uploaded"
                recovered += 1
    if recovered:
        print(f"[startup] Reset {recovered} file(s) from 'transcribing' → 'uploaded' (server was restarted mid-transcription)")
        save_state_raw(st)
    return st

def save_state_raw(st):
    with open(STATE_FILE, "w") as f:
        json.dump(st, f, indent=2)

def save_state(st):
    save_state_raw(st)

state = load_state()

# ── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Voice Editor")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Session routes ───────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        ffmpeg = find_ffmpeg()
        return {"status": "ok", "ffmpeg": ffmpeg}
    except RuntimeError as e:
        return {"status": "error", "error": str(e)}

@app.post("/api/session/new")
def new_session():
    sid = str(uuid.uuid4())[:8]
    (UPLOADS_DIR / sid).mkdir(parents=True, exist_ok=True)
    state["sessions"][sid] = {"files": {}, "name": f"Session {sid}"}
    save_state(state)
    return {"session_id": sid}

@app.get("/api/sessions")
def list_sessions():
    return {"sessions": [{"id": sid, **sd} for sid, sd in state["sessions"].items()]}

@app.post("/api/session/{session_id}/upload")
async def upload_files(session_id: str, files: List[UploadFile] = File(...)):
    if session_id not in state["sessions"]:
        raise HTTPException(404, "Session not found")
    session_dir = UPLOADS_DIR / session_id
    session_dir.mkdir(exist_ok=True)
    uploaded = []
    for f in files:
        fid = str(uuid.uuid4())[:8]
        ext = Path(f.filename).suffix.lower()
        dest = session_dir / f"{fid}{ext}"
        async with aiofiles.open(dest, "wb") as out:
            await out.write(await f.read())
        state["sessions"][session_id]["files"][fid] = {
            "original_name": f.filename,
            "path": str(dest),
            "status": "uploaded",
            "transcript": None,
            "segments": [],
            "silence_removed_path": None,
        }
        uploaded.append({"file_id": fid, "name": f.filename})
    save_state(state)
    return {"uploaded": uploaded}

@app.get("/api/session/{session_id}/status")
def session_status(session_id: str):
    if session_id not in state["sessions"]:
        raise HTTPException(404, "Session not found")
    return state["sessions"][session_id]

@app.post("/api/session/{session_id}/transcribe/{file_id}")
def transcribe_file(session_id: str, file_id: str, background_tasks: BackgroundTasks):
    fdata = _get_file(session_id, file_id)
    if fdata["status"] == "transcribing":
        return {"status": "already_running"}
    state["sessions"][session_id]["files"][file_id]["status"] = "transcribing"
    save_state(state)
    background_tasks.add_task(_do_transcribe, session_id, file_id)
    return {"status": "started"}

@app.post("/api/session/{session_id}/transcribe_all")
def transcribe_all(session_id: str, background_tasks: BackgroundTasks):
    if session_id not in state["sessions"]:
        raise HTTPException(404)
    for fid, fdata in state["sessions"][session_id]["files"].items():
        if fdata["status"] in ("uploaded", "error"):
            state["sessions"][session_id]["files"][fid]["status"] = "transcribing"
            background_tasks.add_task(_do_transcribe, session_id, fid)
    save_state(state)
    return {"status": "started"}

@app.post("/api/session/{session_id}/retranscribe_all")
def retranscribe_all(session_id: str, background_tasks: BackgroundTasks):
    """Force re-transcription of all files, clearing any cached segments."""
    if session_id not in state["sessions"]:
        raise HTTPException(404)
    started = []
    for fid, fdata in state["sessions"][session_id]["files"].items():
        fdata["status"] = "uploaded"
        fdata.pop("segments", None)
        fdata.pop("transcript", None)
        state["sessions"][session_id]["files"][fid]["status"] = "transcribing"
        background_tasks.add_task(_do_transcribe, session_id, fid)
        started.append(fid)
    save_state(state)
    return {"status": "started", "files": started}

@app.post("/api/session/{session_id}/remove_silence/{file_id}")
def remove_silence(session_id: str, file_id: str, background_tasks: BackgroundTasks):
    _get_file(session_id, file_id)
    background_tasks.add_task(_do_remove_silence, session_id, file_id)
    return {"status": "started"}

@app.post("/api/session/{session_id}/remove_silence_all")
def remove_silence_all(session_id: str, background_tasks: BackgroundTasks):
    if session_id not in state["sessions"]:
        raise HTTPException(404)
    for fid, fdata in state["sessions"][session_id]["files"].items():
        if not fdata.get("silence_removed"):
            background_tasks.add_task(_do_remove_silence, session_id, fid)
    return {"status": "started"}

@app.get("/api/audio/{session_id}/{file_id}")
def stream_audio(session_id: str, file_id: str, processed: bool = False):
    fdata = _get_file(session_id, file_id)
    path = (fdata.get("silence_removed_path") if processed else None) or fdata["path"]
    if not Path(path).exists():
        raise HTTPException(404)
    return FileResponse(path)

# ── Auto-assembly ─────────────────────────────────────────────────────────────

@app.post("/api/session/{session_id}/auto_assemble")
def auto_assemble(session_id: str, background_tasks: BackgroundTasks):
    """
    1. Trigger silence removal on any file that hasn't had it yet (async).
    2. Score every transcribed segment.
    3. Group similar segments across files into sentence groups.
    4. Detect retakes (same sentence repeated within same file close in time) — keep best.
    5. Pick highest-scoring segment per group for the suggested assembly.
    6. Return groups in script order with best + alternatives for each.
    """
    if session_id not in state["sessions"]:
        raise HTTPException(404)
    sess = state["sessions"][session_id]
    files = sess.get("files", {})

    # Kick off silence removal in background for any file that needs it
    for fid, fdata in files.items():
        if fdata["status"] == "done" and not fdata.get("silence_removed"):
            background_tasks.add_task(_do_remove_silence, session_id, fid)

    # Collect scored segments from all done files; split any single segment that
    # contains multiple restart attempts (detected via anomalously long word durations).
    scored = []
    for fid, fdata in files.items():
        if fdata["status"] != "done" or not fdata.get("segments"):
            continue
        for seg in fdata["segments"]:
            for sub in _split_retakes(seg):
                sc, details = _score_segment(sub["seg"])
                if sub["total"] > 1:
                    sc = min(100.0, sc + sub["attempt_idx"] * 10)
                scored.append({
                    "file_id": fid,
                    "source_name": fdata["original_name"],
                    "seg": sub["seg"],
                    "score": sc,
                    "score_details": details,
                    "full_text": sub["full_text"],
                    "retake_split": sub["total"] > 1,
                })

    # Drop junk segments: fewer than 3 words or under 0.8s — usually Whisper noise/hallucinations
    scored = [it for it in scored
              if len(it["seg"].get("words", [])) >= 3
              and (it["seg"]["end"] - it["seg"]["start"]) >= 0.8]

    if not scored:
        raise HTTPException(400, "No transcribed segments found. Transcribe files first.")

    # Group by sentence similarity
    groups = _group_segments(scored)

    # Deduplicate retakes within each group
    for g in groups:
        g["items"] = _dedupe_retakes(g["items"])

    # Remove groups that ended up with no items or whose text is empty/junk
    groups = [g for g in groups if g["items"] and len(g["normalized_text"].strip()) > 2]

    ffmpeg = find_ffmpeg()

    # Return top candidates per group, ranked by score — no auto-picking
    # Filter out fragments: must have at least 2 words and span at least 1 second.
    result_groups = []
    for g in groups:
        ranked = sorted(g["items"], key=lambda x: x["score"], reverse=True)
        valid = []
        for it in ranked:
            seg = it["seg"]
            duration = seg.get("end", 0) - seg.get("start", 0)
            word_count = len(seg.get("words", []))
            if duration >= 1.0 and word_count >= 2:
                valid.append(it)
        candidates = [_fmt_item(it, ffmpeg=ffmpeg,
                                   src=files.get(it["file_id"], {}).get("path"),
                                   all_file_segs=files.get(it["file_id"], {}).get("segments", []))
                      for it in valid[:6]]
        result_groups.append({
            "group_id": g["id"],
            "normalized_text": g["normalized_text"],
            "candidates": candidates,   # index 0 = highest scored
        })

    return {"groups": result_groups, "total_groups": len(result_groups)}

# ── Export ────────────────────────────────────────────────────────────────────

def _detect_start_ms(seg, buf_ms, threshold_db=-33, window_ms=15):
    """Scan BACKWARD from buf_ms (the Whisper word position) to find the last
    silent window before speech begins. Used for mid-file segments where the
    pre-buffer region is clear of earlier-sentence content.
    Falls back to buf_ms (word boundary itself) if no silence is found."""
    for i in range(buf_ms, max(-1, buf_ms - 500), -window_ms):
        chunk = seg[max(0, i) : min(len(seg), i + window_ms)]
        if chunk.dBFS <= threshold_db:
            return max(0, i)
    return buf_ms  # no silence found — cut right at the word timestamp

def _detect_speech_onset_ms(seg, threshold_db=-20, window_ms=20):
    """Forward scan from position 0. Returns ms offset where SPEECH (not noise
    or breathing) first rises above threshold_db.

    Uses −20 dBFS to target actual speech energy. Room noise and breathing
    are typically −40 to −25 dBFS; speech is −15 dBFS and above. This
    correctly skips pre-speech silence that Whisper folds into the first
    word timestamp. Falls back to 0 if no onset is found."""
    for i in range(0, max(0, len(seg) - window_ms), window_ms):
        if seg[i : i + window_ms].dBFS > threshold_db:
            return max(0, i - window_ms // 2)  # small pre-roll to keep attack transient
    return 0

def _get_words_in_range(session_id, fid, t_start, t_end):
    """Return word dicts from the file's transcript that fall within [t_start, t_end]."""
    sess  = state["sessions"].get(session_id, {})
    fdata = sess.get("files", {}).get(fid, {})
    words = []
    for seg in fdata.get("segments", []):
        for w in seg.get("words", []):
            ws, we = w.get("start", 0), w.get("end", 0)
            if ws >= t_start - 0.1 and we <= t_end + 0.1:
                words.append({"start": ws, "end": we, "word": w.get("word", "")})
    return sorted(words, key=lambda x: x["start"])

def _seg_words_before(session_id, fid, t):
    """Words in the same Whisper segment whose end < t - 10ms.
    Used to detect whether a deletion precedes the first visible word."""
    sess  = state["sessions"].get(session_id, {})
    fdata = sess.get("files", {}).get(fid, {})
    for s in fdata.get("segments", []):
        if s.get("start", 0) <= t <= s.get("end", float("inf")):
            return [w for w in s.get("words", []) if w.get("end", 0) < t - 0.01]
    return []

def _seg_words_after(session_id, fid, t):
    """Words in the same Whisper segment whose start > t + 10ms.
    Used to detect whether a deletion follows the last visible word."""
    sess  = state["sessions"].get(session_id, {})
    fdata = sess.get("files", {}).get(fid, {})
    for s in fdata.get("segments", []):
        if s.get("start", 0) <= t <= s.get("end", float("inf")):
            return [w for w in s.get("words", []) if w.get("start", 0) > t + 0.01]
    return []

def _detect_end_ms(seg, threshold_db=-33, window_ms=15):
    """Backward scan from the end of seg. Returns the ms position of the last
    window whose energy exceeds threshold_db — i.e. where speech actually ends.
    The caller should apply its fade-out starting from this point."""
    for i in range(len(seg), window_ms, -window_ms):
        if seg[max(0, i - window_ms) : i].dBFS > threshold_db:
            return i
    return len(seg)

def _detect_speech_end_ms(seg, threshold_db=-20, window_ms=20):
    """Backward scan from end. Returns ms where SPEECH last exceeds threshold_db.
    Mirrors _detect_speech_onset_ms but scanning in reverse. Uses −20 dBFS to
    target actual speech energy, skipping trailing noise/breathing that sits
    below speech level but above the −33 dBFS used by _detect_end_ms."""
    for i in range(len(seg), window_ms, -window_ms):
        if seg[max(0, i - window_ms) : i].dBFS > threshold_db:
            return i
    return len(seg)

@app.post("/api/session/{session_id}/export")
def export_audio(session_id: str, body: dict):
    """
    body: { "clips": [{"file_id": "...", "ranges": [{"start":0,"end":1}]}, ...] }

    Per sentence clip:
      - First range start: extracted with 200 ms pre-buffer, then _detect_start_ms
        trims to actual speech onset. Mid-file segments use backward scan (anchored
        to Whisper timestamp so earlier sentences don't bleed). File-start segments
        (Group 1, buf_ms==0) use forward energy scan from position 0.
      - Last range end: extracted with 300 ms post-buffer, then _detect_end_ms finds
        where speech actually ends (fixes Whisper underestimating last-word duration).
        A 70 ms fade-out is applied starting from that detected end — never mid-word.
      - Deletion cuts (between ranges): 25 ms fade-out + fade-in.
      - Sentence start: 35 ms fade-in.
    Between sentences: 380 ms natural gap (unchanged).
    """
    from pydub import AudioSegment

    clips = body.get("clips", [])
    if not clips:
        raise HTTPException(400, "No clips provided")

    ffmpeg = find_ffmpeg()
    _setup_pydub(ffmpeg)
    tmp_dir = Path(tempfile.mkdtemp())

    SENTENCE_FADE_MS    = 35   # sentence start fade-in (unchanged)
    GAP_MS              = 80   # silence added AFTER trimming trailing silence from each clip
    DEL_FADE_MS         = 25   # fade at each word-deletion cut boundary
    END_FADE_MS         = 70   # fade-out applied AFTER detected speech end (60-80 ms)
    PRE_BUF_S           = 0.2  # pre-buffer before first word for start detection
    POST_BUF_S          = 0.3  # post-buffer after last word for end detection
    DEL_START_OFFSET_MS = 100  # extra ms to skip into first visible word when a
                                # deleted word precedes it (clears Whisper boundary bleed)
    DEL_END_GUARD_MS    = 80   # ms past last visible word end to cap end detection
                                # when a deleted word follows (prevents next-word bleed)

    assembled = None
    cursor_ms = 0          # running position in assembled output (ms)
    srt_entries = []       # [{start_ms, end_ms, text}]
    pending_srt = None     # {start_ms, text} — open entry waiting for end

    for i, clip in enumerate(clips):
        fid = clip["file_id"]
        fdata = _get_file(session_id, fid)
        src = fdata["path"]

        ranges = clip.get("ranges") or [{"start": clip.get("start"), "end": clip.get("end")}]
        n = len(ranges)

        # ── First-segment-of-file detection (Group 1 fix) ───────────────────
        # Whisper folds pre-speech silence into the first word's timestamp,
        # making that timestamp unreliable (e.g. "If" stamped 640 ms long when
        # the actual word takes 200 ms).  Detect this by checking whether the
        # file has ANY words before the start of this clip's first range — if
        # not, this is the first segment in the file and needs special handling.
        first_rstart = ranges[0].get("start")  if ranges else None
        last_rend    = ranges[-1].get("end")   if ranges else None

        # ── First-segment-of-file detection ─────────────────────────────────
        words_before = _get_words_in_range(session_id, fid, 0.0,
                                           (first_rstart or 0.0) - 0.1) if first_rstart is not None else []
        is_file_start_clip = (first_rstart is not None and len(words_before) == 0)

        # ── Deletion-boundary detection ──────────────────────────────────────
        # When a deleted word immediately precedes the first visible word, its
        # audio bleeds past Whisper's boundary timestamp.  Detect this by
        # checking for same-segment words just before/after the visible range.
        has_del_before = bool(_seg_words_before(session_id, fid, first_rstart)) if first_rstart is not None else False
        has_del_after  = bool(_seg_words_after(session_id, fid, last_rend))     if last_rend   is not None else False
        # Also detect words from ANY segment ending within 400ms before our start
        # (inter-segment acoustic bleed — the previous sentence's last word leaks in).
        words_ending_before = _get_words_in_range(session_id, fid,
            (first_rstart or 0.0) - 0.4, (first_rstart or 0.0) + 0.02) if first_rstart is not None else []
        has_prev_word_bleed = bool(words_ending_before) and not is_file_start_clip

        # When the previous word bleeds in, find the true acoustic boundary
        # and tighten the first range's start to it.
        if has_prev_word_bleed and first_rstart is not None:
            adj = _find_energy_valley(ffmpeg, src, first_rstart)
            if adj != first_rstart:
                ranges    = list(ranges)
                ranges[0] = dict(ranges[0], start=adj)
                first_rstart = adj

        clip_seg = None

        for j, rng in enumerate(ranges):
            rstart   = rng.get("start") or 0.0
            rend     = rng.get("end")   or 0.0
            is_first = (j == 0)
            is_last  = (j == n - 1)

            PRE_BUF  = 0.05
            POST_BUF = 0.08
            extract_start = max(0.0, rstart - PRE_BUF)
            extract_end   = rend + POST_BUF

            tmp_out = str(tmp_dir / f"r_{i:04d}_{j:04d}.wav")
            _extract_range(ffmpeg, src, tmp_out, extract_start, extract_end)
            seg = AudioSegment.from_wav(tmp_out)

            if len(seg) == 0:
                continue

            start_ms = int((rstart - extract_start) * 1000)
            end_ms   = int((rend   - extract_start) * 1000)
            end_ms   = min(len(seg), end_ms)
            # When a deleted word immediately precedes the first visible word, its
            # audio bleeds past the Whisper boundary — skip 100ms into the range.
            if is_first and has_del_before:
                skip_ms = min(DEL_START_OFFSET_MS, end_ms - start_ms - 1)
                start_ms += max(0, skip_ms)

            seg = seg[start_ms:end_ms]

            if is_first:
                seg = seg.fade_in(min(SENTENCE_FADE_MS, len(seg)))
            if is_last:
                seg = seg.fade_out(min(END_FADE_MS, len(seg)))

            if clip_seg is None:
                clip_seg = seg
            else:
                clip_seg = clip_seg.fade_out(DEL_FADE_MS) + seg.fade_in(DEL_FADE_MS)

        if clip_seg is None or len(clip_seg) == 0:
            continue

        # Strip trailing silence from clip so the gap is consistent regardless
        # of how much natural decay the recording has after the last word.
        clip_seg = _trim_trailing_silence(clip_seg, keep_ms=30)

        if assembled is None or clip.get("no_gap_before"):
            gap_before = 0
        elif clip.get("gap_before_ms") is not None:
            gap_before = max(0, int(clip["gap_before_ms"]))
        else:
            gap_before = GAP_MS

        # SRT: open new entry when subtitle_text is provided (first clip of each sentence)
        subtitle_text = clip.get("subtitle_text")
        if subtitle_text is not None and str(subtitle_text).strip():
            if pending_srt is not None:
                srt_entries.append({**pending_srt, "end_ms": cursor_ms})
            pending_srt = {"start_ms": cursor_ms + gap_before, "text": str(subtitle_text).strip()}

        cursor_ms += gap_before + len(clip_seg)

        if assembled is None:
            assembled = clip_seg
        elif gap_before == 0:
            assembled = assembled + clip_seg
        else:
            assembled = assembled + AudioSegment.silent(duration=gap_before) + clip_seg

    if assembled is None:
        raise HTTPException(400, "No audio produced")

    assembled = assembled.fade_out(min(END_FADE_MS, len(assembled)))

    # Close last pending SRT entry
    if pending_srt is not None:
        srt_entries.append({**pending_srt, "end_ms": cursor_ms})

    export_id = str(uuid.uuid4())[:8]
    export_path = EXPORTS_DIR / f"export_{export_id}.wav"
    assembled.export(str(export_path), format="wav", parameters=["-acodec", "pcm_s16le"])

    # Generate SRT file
    def _ms_to_srt(ms):
        h, rem = divmod(int(ms), 3_600_000)
        m, rem = divmod(rem, 60_000)
        s, ms_ = divmod(rem, 1_000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms_:03d}"

    srt_lines = []
    for idx, entry in enumerate(srt_entries, 1):
        srt_lines.append(str(idx))
        srt_lines.append(f"{_ms_to_srt(entry['start_ms'])} --> {_ms_to_srt(entry['end_ms'])}")
        srt_lines.append(entry["text"])
        srt_lines.append("")
    srt_content = "\n".join(srt_lines)

    import zipfile as _zipfile
    zip_path = EXPORTS_DIR / f"export_{export_id}.zip"
    with _zipfile.ZipFile(str(zip_path), "w", _zipfile.ZIP_DEFLATED) as zf:
        zf.write(str(export_path), f"export_{export_id}.wav")
        zf.writestr(f"export_{export_id}.srt", srt_content)
    export_path.unlink(missing_ok=True)  # remove raw wav, zip has it

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return {"export_id": export_id, "filename": zip_path.name}

@app.get("/api/export/{filename}")
def download_export(filename: str):
    path = EXPORTS_DIR / filename
    if not path.exists():
        raise HTTPException(404)
    if filename.endswith(".zip"):
        media_type = "application/zip"
    elif filename.endswith(".srt"):
        media_type = "text/plain"
    else:
        media_type = "audio/wav"
    return FileResponse(str(path), media_type=media_type, filename=filename)

# ── silero-VAD model (loaded once, reused across calls) ──────────────────────

_silero_vad_model = None

def _get_silero_vad():
    global _silero_vad_model
    if _silero_vad_model is not None:
        return _silero_vad_model
    try:
        from silero_vad import load_silero_vad
        _silero_vad_model = load_silero_vad(onnx=False)
        print("[VAD] silero-vad model loaded.")
    except Exception as e:
        print(f"[VAD] silero-vad not available ({e}); falling back to energy detection.")
        _silero_vad_model = None
    return _silero_vad_model


def _vad_speech_mask(ffmpeg, src, start_s, end_s, threshold=0.35):
    """
    Run silero-VAD on a slice of audio and return a function:
        is_speech(t_abs) -> bool
    that returns True if the audio at absolute time t_abs is speech.

    The VAD operates at 16 kHz in 30ms windows, giving ~33Hz temporal resolution.
    threshold=0.35 is conservative — errs toward treating ambiguous frames as speech
    so we never clip real word content.
    """
    import torch
    vad_model = _get_silero_vad()
    if vad_model is None:
        return None

    pad = 0.10  # extract 100ms extra on each side to avoid edge effects
    ex_start = max(0.0, start_s - pad)
    ex_end   = end_s + pad

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp = f.name
        r = subprocess.run(
            [ffmpeg, "-y", "-i", src,
             "-ss", str(ex_start), "-t", str(ex_end - ex_start),
             "-ar", "16000", "-ac", "1", tmp],
            capture_output=True
        )
        if r.returncode != 0 or not os.path.exists(tmp):
            return None

        from silero_vad import read_audio, get_speech_timestamps
        wav = read_audio(tmp, sampling_rate=16000)

        # get_speech_timestamps returns list of {start: sample, end: sample} dicts
        # where sample indices are at 16000 Hz.
        timestamps = get_speech_timestamps(
            wav, vad_model,
            sampling_rate=16000,
            threshold=threshold,
            min_silence_duration_ms=80,   # gaps shorter than 80ms stay as speech
            min_speech_duration_ms=50,    # ignore very brief spurious speech detections
            return_seconds=False,
        )

        # Build a frame mask at 10ms resolution covering [ex_start, ex_end]
        FRAME_S = 0.010
        total_frames = int((ex_end - ex_start) / FRAME_S) + 2
        mask = [False] * total_frames

        for ts in timestamps:
            ts_start_s = ts["start"] / 16000.0
            ts_end_s   = ts["end"]   / 16000.0
            fi_s = max(0, int((ts_start_s - pad) / FRAME_S))
            fi_e = min(total_frames - 1, int((ts_end_s - pad) / FRAME_S) + 1)
            for fi in range(fi_s, fi_e + 1):
                mask[fi] = True

        def is_speech(t_abs):
            t_rel = t_abs - start_s
            fi = int(t_rel / FRAME_S)
            if fi < 0 or fi >= len(mask):
                return False
            return mask[fi]

        return is_speech

    except Exception:
        return None
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


# ── Word boundary refinement ──────────────────────────────────────────────────

def _refine_word_timestamps(ffmpeg, src, segments):
    """
    Refine word END timestamps using silero-VAD (neural voice activity detector).

    silero-VAD operates at frame level (~30ms windows) and gives a speech-probability
    score per frame. This is far more reliable than energy thresholding for:
      - Words ending with quiet consonants (d, t, k, s) that fall below energy threshold
      - Rooms with varying background noise
      - Any speaker, microphone, or recording environment

    Strategy:
      - Run VAD once per segment on a window that extends 600ms past the last word.
      - For each word's END: find the latest VAD-speech frame within [whisper_end - 60ms,
        whisper_end + 600ms] (last word) or [whisper_end - 60ms, next_word_start] (inner).
      - Keep Whisper/stable-ts START timestamps unchanged — stable-ts already does
        mel-spectrogram alignment for starts.
      - Falls back to energy-based detection if silero-VAD is unavailable.
    """
    PAD_S      = 0.60   # search window past last word's Whisper end
    PAD_S_INNER = 0.05  # small pad for inner words (capped by next word's start anyway)
    JITTER_S   = 0.06   # allow end to move this far before Whisper's timestamp

    vad_available = _get_silero_vad() is not None

    refined_segs = []
    for seg in segments:
        words = seg.get("words", [])
        if not words:
            refined_segs.append(seg)
            continue

        seg_start = words[0]["start"]
        seg_end   = words[-1]["end"]
        vad_end   = seg_end + PAD_S

        is_speech = None
        if vad_available:
            is_speech = _vad_speech_mask(ffmpeg, src, seg_start, vad_end)

        if is_speech is None:
            # Fallback: energy-based end detection
            refined_segs.append(_refine_seg_energy(ffmpeg, src, seg))
            continue

        new_words = []
        for wi, w in enumerate(words):
            w_end   = w["end"]
            is_last = (wi == len(words) - 1)

            # Search window for end: [w_end - JITTER_S, search_max]
            search_start = max(seg_start, w_end - JITTER_S)
            if is_last:
                search_max = vad_end
            else:
                next_start = words[wi + 1]["start"]
                search_max = next_start  # never push into next word

            # Walk forward from search_max back to search_start to find the LAST
            # VAD-speech moment — this is where the word actually ends acoustically.
            STEP = 0.010   # 10ms resolution
            refined_end = w_end  # default: keep Whisper's value
            t = search_max
            while t >= search_start:
                if is_speech(t):
                    refined_end = t + STEP  # include this frame fully
                    break
                t -= STEP

            new_words.append({**w, "end": refined_end})

        refined_segs.append({**seg, "words": new_words})

    return refined_segs


def _refine_seg_energy(ffmpeg, src, seg):
    """Energy-based fallback for a single segment when silero-VAD is unavailable."""
    import tempfile, subprocess
    from pydub import AudioSegment as _AS

    words = seg.get("words", [])
    if not words:
        return seg

    FRAME_MS = 5
    PAD_S    = 0.60
    THRESH_MUL = 2.0
    SUSTAIN_F  = 4

    seg_start = words[0]["start"]
    seg_end   = words[-1]["end"]
    extract_s = max(0.0, seg_start)
    extract_e = seg_end + PAD_S

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp = f.name
        r = subprocess.run(
            [ffmpeg, "-y", "-i", src,
             "-ss", str(extract_s), "-t", str(extract_e - extract_s),
             "-ar", "16000", "-ac", "1", tmp],
            capture_output=True
        )
        if r.returncode != 0 or not os.path.exists(tmp):
            return seg

        audio = _AS.from_wav(tmp)
        raw_frames = [audio[i:i+FRAME_MS].rms for i in range(0, len(audio)-FRAME_MS+1, FRAME_MS)]
        if not raw_frames:
            return seg

        half = 2
        frames = []
        for i in range(len(raw_frames)):
            w = raw_frames[max(0, i-half): i+half+1]
            frames.append(sorted(w)[len(w)//2])

        sorted_rms = sorted(frames)
        noise_floor = max(10, sorted_rms[max(0, len(sorted_rms)//5)] * THRESH_MUL)

        def t2f(t): return int((t - extract_s) * 1000 / FRAME_MS)
        def f2t(f): return extract_s + f * FRAME_MS / 1000.0

        n = len(frames)
        new_words = []
        for wi, w in enumerate(words):
            is_last = (wi == len(words) - 1)
            end_hi = min(n-1, t2f(w["end"] + (PAD_S if is_last else 0.05)))
            end_lo = max(0, t2f(w["end"]) - SUSTAIN_F*2)
            best_f = end_lo
            silence = 0
            for fi in range(end_hi, end_lo-1, -1):
                if frames[fi] < noise_floor:
                    silence += 1
                else:
                    if silence >= SUSTAIN_F:
                        best_f = fi
                        break
                    silence = 0
            else:
                best_f = end_hi
            refined_end = f2t(best_f + 1)
            if not is_last:
                refined_end = min(refined_end, words[wi+1]["start"])
            new_words.append({**w, "end": refined_end})

        return {**seg, "words": new_words}
    except Exception:
        return seg
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_file(session_id, file_id):
    sess = state["sessions"].get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    fdata = sess["files"].get(file_id)
    if not fdata:
        raise HTTPException(404, "File not found")
    return fdata

def _find_energy_valley(ffmpeg, src, approx_t, search_before=0.30, step_s=0.005):
    """
    Scan the audio in [approx_t - search_before, approx_t + 0.03] in step_s chunks
    and return the timestamp with the lowest RMS energy.  That point is the true
    acoustic boundary between the previous word's tail and the next word's onset.
    Falls back to approx_t if no clear quieter valley is found (< 30 % of original RMS).
    """
    win_start = max(0.0, approx_t - search_before)
    win_end   = approx_t + 0.03
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    try:
        cmd = [ffmpeg, "-y", "-i", src,
               "-ss", str(win_start), "-to", str(win_end),
               "-ar", "16000", "-ac", "1", tmp]
        subprocess.run(cmd, capture_output=True, check=False)
        if not os.path.exists(tmp) or os.path.getsize(tmp) < 100:
            return approx_t
        window = AudioSegment.from_wav(tmp)
    except Exception:
        return approx_t
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

    if len(window) < 10:
        return approx_t

    step_ms       = max(1, int(step_s * 1000))
    search_end_ms = int((approx_t - win_start) * 1000)  # only search BEFORE approx_t
    best_rms, best_t = float("inf"), approx_t

    for i in range(0, max(1, search_end_ms - step_ms), step_ms):
        chunk = window[i : i + step_ms]
        if len(chunk) == step_ms:
            rms = chunk.rms
            if rms < best_rms:
                best_rms = rms
                best_t   = win_start + (i + step_ms / 2) / 1000.0

    # Only move if valley is meaningfully quieter than the original position
    orig_ms    = max(0, int((approx_t - win_start) * 1000))
    orig_chunk = window[orig_ms : orig_ms + step_ms]
    orig_rms   = orig_chunk.rms if len(orig_chunk) == step_ms else float("inf")

    if orig_rms > 0 and best_rms < orig_rms * 0.70:   # ≥ ~3 dB quieter
        return best_t

    return approx_t


def _trim_trailing_silence(seg, keep_ms=30):
    """
    Remove trailing silence from an AudioSegment, keeping keep_ms of natural decay.
    Uses a dynamic threshold derived from the segment's own noise floor so it works
    on any recording regardless of room noise or microphone gain.
    """
    if len(seg) == 0:
        return seg
    CHUNK = 5  # ms per energy measurement frame
    # Build per-chunk RMS in reverse to find where speech ends
    chunks = [seg[max(0, len(seg) - (i + 1) * CHUNK): len(seg) - i * CHUNK]
              for i in range(len(seg) // CHUNK)]
    if not chunks:
        return seg
    rms_vals = [c.rms for c in chunks]
    # Dynamic threshold: median of quietest 20% of frames × 3
    sorted_rms = sorted(rms_vals)
    noise_floor = sorted_rms[max(0, len(sorted_rms) // 5)] * 3
    noise_floor = max(noise_floor, 20)  # absolute minimum to avoid over-trimming
    # Walk from the end; find first frame that exceeds the threshold
    silent_frames = 0
    for rms in rms_vals:
        if rms < noise_floor:
            silent_frames += 1
        else:
            break
    trim_ms = max(0, silent_frames * CHUNK - keep_ms)
    if trim_ms > 0:
        seg = seg[:len(seg) - trim_ms]
    return seg


def _extract_range(ffmpeg, src, out, start, end):
    cmd = [ffmpeg, "-y", "-i", src]
    if start is not None:
        cmd += ["-ss", str(start)]
    if end is not None:
        cmd += ["-to", str(end)]
    cmd += ["-acodec", "pcm_s16le", out]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode()[:300]}")

def _seg_to_ranges(seg):
    """Build playback ranges for a segment, skipping absorber (dead zone) words.

    Two kinds of absorbers are handled:
    - Near-START: a slow word within the first 3 positions with >= 3 words after it.
      These are skipped entirely so candidates start cleanly from the next real word.
    - Near-END: a slow word with < 3 words after it.
      The first 250ms (clean pronunciation) is kept, then we jump past the absorber.

    Word-level timestamps are used for all boundaries instead of segment-level
    timestamps, which have EDGE_BUF offsets that can land mid-word.
    """
    words = seg.get("words", [])
    if not words:
        return [{"start": seg["start"], "end": seg["end"]}]
    durations = [w.get("end", 0) - w.get("start", 0) for w in words]
    median = sorted(durations)[len(durations) // 2] or 0.2

    # Use actual word boundaries, not EDGE_BUF-shifted segment timestamps.
    first_word_start = words[0].get("start", seg["start"])
    last_word_end    = words[-1].get("end",  seg["end"])

    ranges, cur_start = [], first_word_start
    for i, (w, d) in enumerate(zip(words, durations)):
        is_absorber = d > 0.9 and d > 2.5 * median
        w_start = w.get("start", 0)
        w_end   = w.get("end",   0)

        if is_absorber and i < 3 and (len(words) - i - 1) >= 3:
            # Near-start absorber: flush any words before it, then skip past it.
            if w_start > cur_start:
                ranges.append({"start": cur_start, "end": w_start})
            cur_start = w_end

        elif is_absorber and i >= 3 and (len(words) - i - 1) < 3:
            # Near-end absorber: keep first 250ms for clean pronunciation, skip rest.
            clean_end = w_start + 0.25
            if clean_end > cur_start:
                ranges.append({"start": cur_start, "end": clean_end})
            cur_start = w_end

    if cur_start < last_word_end:
        ranges.append({"start": cur_start, "end": last_word_end})

    return ranges or [{"start": first_word_start, "end": last_word_end}]


def _fmt_item(item, ffmpeg=None, src=None, all_file_segs=None):
    seg = item["seg"]
    words = seg.get("words", [])
    durations = [w.get("end", 0) - w.get("start", 0) for w in words]
    median = (sorted(durations)[len(durations) // 2] or 0.2) if durations else 0.2
    ranges = _seg_to_ranges(seg)

    # Detect zero-gap boundary: previous segment ends within 80ms of our first word.
    # Detect zero-gap boundary: if the previous segment's last word ends within
    # 80ms of our first word starting (including overlap), push the range start
    # forward by a fixed 30ms to clear the acoustic tail of the previous word.
    # Using updated refined seg["end"] values ensures accurate gap measurement.
    # The cross-segment clamping in _do_transcribe already handles large overlaps;
    # this handles the remaining acoustic decay (reverb/room tail) in tight gaps.
    if words and all_file_segs:
        first_word_t = words[0].get("start", ranges[0]["start"])
        prev_end = None
        for s in all_file_segs:
            s_end = s.get("end", 0)
            # seg["end"] is now refined_last_word_end + EDGE_BUF (0.08)
            # so actual last-word end ≈ s_end - 0.08
            actual_end = s_end - 0.08
            if actual_end <= first_word_t + 0.01 and (prev_end is None or actual_end > prev_end):
                prev_end = actual_end
        if prev_end is not None and (first_word_t - prev_end) < 0.08:
            BLEED_SKIP = 0.030  # fixed 30ms — clears acoustic tail without eating the word
            new_start = first_word_t + BLEED_SKIP
            ranges[0] = dict(ranges[0], start=new_start)

    return {
        "file_id": item["file_id"],
        "source_name": item["source_name"],
        "segment_id": seg.get("id"),
        "start": ranges[0]["start"],
        "end": ranges[-1]["end"],
        "text": seg["text"],
        "score": item["score"],
        "score_details": item["score_details"],
        "ranges": ranges,
    }

# ── Scoring ───────────────────────────────────────────────────────────────────

FILLERS = {"um", "uh", "er", "ah", "hmm", "like", "basically", "literally",
           "right", "so", "okay", "ok", "well", "just", "actually", "you know"}

def _score_segment(seg):
    text = seg.get("text", "").lower()
    words_data = seg.get("words", [])
    tokens = re.sub(r"[^a-z0-9'\s]", "", text).split()
    score = 100.0
    details = {}

    # Filler words
    fillers = [t for t in tokens if t in FILLERS]
    filler_count = len(fillers)
    score -= filler_count * 8
    details["fillers"] = filler_count
    details["filler_words"] = fillers[:5]

    # Stumbles: word repeated within a 5-word window
    stumbles = 0
    for i, tok in enumerate(tokens):
        if len(tok) < 2:
            continue
        window = [tokens[j].rstrip("'s") for j in range(max(0, i - 5), i)]
        if tok.rstrip("'s") in window:
            stumbles += 1
    score -= stumbles * 12
    details["stumbles"] = stumbles

    # Silence gaps between words (> 0.35s = noticeable pause)
    silence_gap_penalty = 0.0
    gap_count = 0
    if len(words_data) >= 2:
        for i in range(1, len(words_data)):
            gap = words_data[i]["start"] - words_data[i - 1]["end"]
            if gap > 0.35:
                silence_gap_penalty += min(gap, 2.5)
                gap_count += 1
    score -= silence_gap_penalty * 4
    details["silence_gaps"] = gap_count

    # Average word confidence from Whisper
    if words_data:
        avg_conf = sum(w.get("probability", 0.85) for w in words_data) / len(words_data)
        score += (avg_conf - 0.75) * 20
        details["avg_confidence"] = round(avg_conf, 3)

    # Speech rate naturalness: expected ~0.3–0.5s per word
    if tokens:
        dur = seg["end"] - seg["start"]
        secs_per_word = dur / len(tokens)
        # Penalty for very slow speech (lots of pausing) or too fast
        if secs_per_word > 0.6:
            score -= (secs_per_word - 0.6) * 15
        elif secs_per_word < 0.15:
            score -= (0.15 - secs_per_word) * 10
        details["secs_per_word"] = round(secs_per_word, 3)

    score = round(max(0.0, min(100.0, score)), 1)
    return score, details

# ── Sentence grouping ─────────────────────────────────────────────────────────

STOP_WORDS = {"the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
              "for", "of", "with", "is", "are", "was", "were", "be", "been",
              "have", "has", "had", "do", "does", "did", "will", "would",
              "could", "should", "may", "might", "that", "this", "it"}

def _normalize(text):
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", "", text)
    tokens = [t for t in text.split() if t not in FILLERS and t not in STOP_WORDS and len(t) > 1]
    return " ".join(tokens)

def _sim(a, b):
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()

def _group_segments(scored, threshold=0.60):
    """
    Greedy clustering: assign each segment to the most similar existing group
    if similarity >= threshold, otherwise create a new group.
    Very short segments (<= 2 content words) get a higher threshold to avoid
    false merges of phrases like "okay" or "so".
    """
    groups = []
    for item in scored:
        norm = _normalize(item.get("full_text") or item["seg"]["text"])
        if not norm.strip():
            continue
        word_count = len(norm.split())
        # Short phrases need higher similarity to merge
        effective_threshold = threshold if word_count > 3 else 0.80

        best_group = None
        best_sim = effective_threshold
        for g in groups:
            s = _sim(norm, g["normalized_text"])
            if s > best_sim:
                best_sim = s
                best_group = g

        if best_group is not None:
            best_group["items"].append(item)
            # Keep the longer/more-complete representative text for the group
            if len(norm) > len(best_group["normalized_text"]):
                best_group["normalized_text"] = norm
        else:
            groups.append({
                "id": len(groups),
                "normalized_text": norm,
                "items": [item],
            })
    return groups

# ── Retake deduplication ──────────────────────────────────────────────────────

def _split_retakes(seg):
    """
    Split a Whisper segment that contains multiple restart attempts.
    Restarts are detected as words with anomalously long durations — the word
    absorbs the audio of the speaker stopping and restarting.
    Each sub-attempt gets its own start/end (skipping the absorber word's full
    duration), so playback only covers that attempt's clean audio.
    Returns list of dicts: { seg: {...}, full_text, attempt_idx, total }
    """
    words = seg.get("words", [])
    full_text = seg.get("text", "")

    def _wrap(ws, start, end, idx, total):
        text = " ".join(w.get("word", "").strip() for w in ws)
        # Give each sub-segment a unique id so word-map lookups stay scoped
        # to the correct attempt (all sub-segs would otherwise share the parent id).
        mock = dict(seg, start=start, end=end, words=ws, text=text,
                    id=f"{seg.get('id', 0)}_{idx}")
        return {"seg": mock, "full_text": full_text, "attempt_idx": idx, "total": total}

    if len(words) < 3:
        return [_wrap(words, seg["start"], seg["end"], 0, 1)]

    durations = [w.get("end", 0) - w.get("start", 0) for w in words]
    median = sorted(durations)[len(durations) // 2] or 0.2

    # A word is a restart absorber if:
    #   - duration > 0.9s AND > 2.5× median (anomalously long)
    #   - at least 3 words precede it (enough for a meaningful attempt)
    #   - at least 3 words follow it (the next attempt has real content)
    split_at = [i for i, d in enumerate(durations)
                if d > 0.9 and d > 2.5 * median
                and i >= 3 and (len(words) - i - 1) >= 3]

    if not split_at:
        return [_wrap(words, seg["start"], seg["end"], 0, 1)]

    total = len(split_at) + 1
    results = []
    boundaries = [0] + split_at + [len(words)]

    for i in range(total):
        lo, hi = boundaries[i], boundaries[i + 1]
        if i == 0:
            # Attempt before first absorber: ends at absorber word start
            chunk = words[lo:hi]          # excludes the absorber word
            if chunk:
                results.append(_wrap(chunk, chunk[0]["start"],
                                     words[split_at[0]]["start"], i, total))
        elif i == total - 1:
            # Last attempt: starts 80ms after absorber ends to clear bleed
            chunk = words[lo + 1:hi]
            if chunk:
                results.append(_wrap(chunk, words[split_at[-1]]["end"] + 0.08,
                                     chunk[-1]["end"], i, total))
        else:
            # Middle attempt: starts 80ms after previous absorber ends
            chunk = words[lo + 1:hi]
            if chunk:
                results.append(_wrap(chunk, words[split_at[i - 1]]["end"] + 0.08,
                                     words[split_at[i]]["start"], i, total))

    return results if results else [_wrap(words, seg["start"], seg["end"], 0, 1)]


def _dedupe_retakes(items, time_window=2.0):
    """
    Only collapse truly overlapping Whisper segments (within 2 seconds of each
    other in the same file) — these are Whisper hallucinations or re-segmentations
    of the same audio. All distinct takes recorded at different times are preserved
    so the user can compare them and pick the best parts.
    Across files, always keep all.
    """
    by_file = {}
    for item in items:
        by_file.setdefault(item["file_id"], []).append(item)

    result = []
    for fid, file_items in by_file.items():
        if len(file_items) == 1:
            result.extend(file_items)
            continue

        file_items.sort(key=lambda x: x["seg"]["start"])

        # Only deduplicate segments that start within 2s of each other
        clusters = [[file_items[0]]]
        for item in file_items[1:]:
            prev_start = clusters[-1][0]["seg"]["start"]
            if item["seg"]["start"] - prev_start <= time_window:
                clusters[-1].append(item)
            else:
                clusters.append([item])

        def _cluster_score(item):
            words = item["seg"].get("words", [])
            if not words:
                return item["score"]
            durations = sorted(w.get("end", 0) - w.get("start", 0) for w in words)
            median = durations[len(durations) // 2] or 0.3
            max_word_dur = max(durations)
            stumble_penalty = max(0, max_word_dur - 2 * median) * 20
            return item["score"] - stumble_penalty

        for cluster in clusters:
            best = max(cluster, key=_cluster_score)
            result.append(best)

    return result

# ── Transcription & silence removal (background tasks) ───────────────────────

def _do_transcribe(session_id: str, file_id: str):
    # Ensure our local ffmpeg is on PATH so Whisper can decode m4a/mp3
    ffmpeg_dir = str(BINS_DIR)
    if ffmpeg_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    fdata = state["sessions"][session_id]["files"][file_id]
    try:
        model = _get_whisper_model()  # large → medium, cached after first load
        result = model.transcribe(
            fdata["path"],
            word_timestamps=True,
            condition_on_previous_text=False,  # prevents timestamp drift between segments
            fp16=False,                         # full 32-bit precision on CPU for accuracy
            temperature=0,                      # greedy decoding — consistent timestamps
            verbose=False,
        )

        # stable-ts returns a WhisperResult object; plain whisper returns a dict.
        # stable-ts provides to_dict() which outputs standard Whisper-compatible format.
        if hasattr(result, "to_dict"):
            raw_segments = result.to_dict()["segments"]
        else:
            raw_segments = result["segments"]

        EDGE_BUF = 0.08  # 80 ms buffer — captures words right at segment edges
        segments = []
        for idx, seg in enumerate(raw_segments):
            raw_words = seg.get("words", [])
            # Extend segment boundaries to include any words slightly outside
            seg_start = min((w["start"] for w in raw_words), default=seg["start"])
            seg_end   = max((w["end"]   for w in raw_words), default=seg["end"])
            segments.append({
                "id":    seg.get("id", idx),  # stable-ts omits "id"; fall back to index
                "start": max(0.0, seg_start - EDGE_BUF),
                "end":   seg_end + EDGE_BUF,
                "text":  seg["text"].strip(),
                "words": raw_words,
            })

        # Refine word END timestamps using energy detection in the actual audio.
        # This extends last words past Whisper's clipped end (e.g. "instead." → full word).
        ffmpeg = find_ffmpeg()
        segments = _refine_word_timestamps(ffmpeg, fdata["path"], segments)

        # Update each segment's stored "end" to match the refined last-word end so that
        # zero-gap detection in _fmt_item uses accurate timestamps (not pre-refinement ones).
        for seg in segments:
            rw = seg.get("words", [])
            if rw:
                seg["end"] = rw[-1]["end"] + EDGE_BUF

        # Fix cross-segment overlaps: stable-ts can produce timestamps where segment[i]'s
        # first word starts before segment[i-1]'s last word ends (independent refinement).
        # Clamp the first word of each segment to start no earlier than the previous
        # segment's last word ends (prevents acoustic bleed from the previous segment).
        for i in range(1, len(segments)):
            prev_words = segments[i - 1].get("words", [])
            curr_words = segments[i].get("words", [])
            if not prev_words or not curr_words:
                continue
            prev_last_end = prev_words[-1]["end"]
            curr_first    = curr_words[0]
            if curr_first["start"] < prev_last_end:
                if prev_last_end < curr_first.get("end", prev_last_end + 0.05):
                    # Clamp current segment's first word start to after previous last word.
                    curr_words[0] = {**curr_first, "start": prev_last_end}
                    segments[i] = {**segments[i], "words": curr_words}
                else:
                    # Clamping would create negative duration — trim the previous
                    # segment's last word end to current first word's start instead.
                    # (The refinement over-extended the prev last word into the next
                    # word's territory since there's no inter-segment capping in refine.)
                    trim_to = curr_first["start"]
                    prev_words[-1] = {**prev_words[-1], "end": trim_to}
                    segments[i - 1] = {**segments[i - 1], "words": prev_words}
                    # Update seg end accordingly
                    segments[i - 1]["end"] = trim_to + EDGE_BUF

        # stable-ts WhisperResult uses .text attribute; plain whisper uses result["text"]
        transcript_text = result.text if hasattr(result, "text") else result["text"]
        fdata["transcript"] = transcript_text.strip()
        fdata["segments"] = segments
        fdata["status"] = "done"
    except Exception as e:
        fdata["status"] = "error"
        fdata["error"] = str(e)
    save_state(state)

def _do_remove_silence(session_id: str, file_id: str):
    from pydub import AudioSegment
    from pydub.silence import detect_silence

    ffmpeg = find_ffmpeg()
    _setup_pydub(ffmpeg)

    fdata = state["sessions"][session_id]["files"][file_id]
    src = fdata["path"]
    out_path = Path(src).parent / f"{Path(src).stem}_nosilence.wav"

    fdata["removing_silence"] = True
    save_state(state)

    try:
        audio = AudioSegment.from_file(src)

        # Detect pauses > 300 ms that are quieter than -30 dBFS (catches breaths/mouth sounds)
        MIN_SILENCE_MS   = 300   # only shorten gaps this long or longer
        SILENCE_THRESH   = -30   # dBFS — above this is treated as speech
        TARGET_GAP_MS    = 150   # replace detected gaps with this natural pause length

        silent_ranges = detect_silence(
            audio,
            min_silence_len=MIN_SILENCE_MS,
            silence_thresh=SILENCE_THRESH,
        )

        if not silent_ranges:
            audio.export(str(out_path), format="wav", parameters=["-acodec", "pcm_s16le"])
        else:
            parts = []
            prev_end = 0
            for sil_start, sil_end in silent_ranges:
                parts.append(audio[prev_end:sil_start])
                parts.append(AudioSegment.silent(duration=TARGET_GAP_MS))
                prev_end = sil_end
            parts.append(audio[prev_end:])
            result = parts[0]
            for p in parts[1:]:
                result = result + p
            result.export(str(out_path), format="wav", parameters=["-acodec", "pcm_s16le"])

        fdata["silence_removed_path"] = str(out_path)
        fdata["silence_removed"] = True
    except Exception as e:
        fdata["silence_error"] = str(e)
    finally:
        fdata["removing_silence"] = False
    save_state(state)

# ── Frontend ──────────────────────────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=False)
