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

# ── FFmpeg ───────────────────────────────────────────────────────────────────

def find_ffmpeg():
    local = BINS_DIR / "ffmpeg"
    if local.exists():
        return str(local)
    system = shutil.which("ffmpeg")
    if system:
        return system
    raise RuntimeError("ffmpeg not found. Run setup.sh first.")

# ── State ────────────────────────────────────────────────────────────────────

def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"sessions": {}}

def save_state(st):
    with open(STATE_FILE, "w") as f:
        json.dump(st, f, indent=2)

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

    # Collect scored segments from all done files
    scored = []
    for fid, fdata in files.items():
        if fdata["status"] != "done" or not fdata.get("segments"):
            continue
        for seg in fdata["segments"]:
            sc, details = _score_segment(seg)
            scored.append({
                "file_id": fid,
                "source_name": fdata["original_name"],
                "seg": seg,
                "score": sc,
                "score_details": details,
            })

    if not scored:
        raise HTTPException(400, "No transcribed segments found. Transcribe files first.")

    # Group by sentence similarity
    groups = _group_segments(scored)

    # Deduplicate retakes within each group
    for g in groups:
        g["items"] = _dedupe_retakes(g["items"])

    # Remove groups that ended up with no items or whose text is empty/junk
    groups = [g for g in groups if g["items"] and len(g["normalized_text"].strip()) > 2]

    # Return top-3 candidates per group, ranked by score — no auto-picking
    result_groups = []
    for g in groups:
        ranked = sorted(g["items"], key=lambda x: x["score"], reverse=True)
        candidates = [_fmt_item(it) for it in ranked[:3]]
        result_groups.append({
            "group_id": g["id"],
            "normalized_text": g["normalized_text"],
            "candidates": candidates,   # index 0 = highest scored
        })

    return {"groups": result_groups, "total_groups": len(result_groups)}

# ── Export ────────────────────────────────────────────────────────────────────

@app.post("/api/session/{session_id}/export")
def export_audio(session_id: str, body: dict):
    """
    body: { "clips": [{"file_id": "...", "use_processed": false, "ranges": [{"start":0,"end":1}]}, ...] }
    Supports old-style {start, end} too for backwards compat.
    """
    clips = body.get("clips", [])
    if not clips:
        raise HTTPException(400, "No clips provided")

    ffmpeg = find_ffmpeg()
    tmp_dir = Path(tempfile.mkdtemp())
    clip_paths = []

    for i, clip in enumerate(clips):
        fid = clip["file_id"]
        fdata = _get_file(session_id, fid)
        use_processed = clip.get("use_processed", False)
        # For export, always use original file (Whisper timestamps are relative to it)
        src = fdata["path"]

        ranges = clip.get("ranges")
        if not ranges:
            ranges = [{"start": clip.get("start"), "end": clip.get("end")}]

        for j, rng in enumerate(ranges):
            out = tmp_dir / f"clip_{i:04d}_{j:04d}.wav"
            _extract_range(ffmpeg, src, str(out), rng.get("start"), rng.get("end"))
            clip_paths.append(str(out))

    list_file = tmp_dir / "list.txt"
    with open(list_file, "w") as f:
        for p in clip_paths:
            f.write(f"file '{p}'\n")

    export_id = str(uuid.uuid4())[:8]
    export_path = EXPORTS_DIR / f"export_{export_id}.wav"
    subprocess.run([
        ffmpeg, "-y", "-f", "concat", "-safe", "0",
        "-i", str(list_file), "-acodec", "pcm_s16le", str(export_path)
    ], check=True, capture_output=True)

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return {"export_id": export_id, "filename": export_path.name}

@app.get("/api/export/{filename}")
def download_export(filename: str):
    path = EXPORTS_DIR / filename
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(str(path), media_type="audio/wav", filename=filename)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_file(session_id, file_id):
    sess = state["sessions"].get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    fdata = sess["files"].get(file_id)
    if not fdata:
        raise HTTPException(404, "File not found")
    return fdata

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

def _fmt_item(item):
    seg = item["seg"]
    return {
        "file_id": item["file_id"],
        "source_name": item["source_name"],
        "segment_id": seg["id"],
        "start": seg["start"],
        "end": seg["end"],
        "text": seg["text"],
        "score": item["score"],
        "score_details": item["score_details"],
        "ranges": [{"start": seg["start"], "end": seg["end"]}],
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
        norm = _normalize(item["seg"]["text"])
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

def _dedupe_retakes(items, time_window=60.0):
    """
    Within the same file, segments in this group that are close in time
    are retakes of each other. Keep only the highest-scoring one per cluster.
    Across files, always keep all (they're genuine alternatives).
    """
    by_file = {}
    for item in items:
        by_file.setdefault(item["file_id"], []).append(item)

    result = []
    for fid, file_items in by_file.items():
        if len(file_items) == 1:
            result.extend(file_items)
            continue

        # Sort by time
        file_items.sort(key=lambda x: x["seg"]["start"])

        # Cluster: consecutive segments within time_window of the cluster's anchor
        clusters = [[file_items[0]]]
        for item in file_items[1:]:
            anchor_start = clusters[-1][0]["seg"]["start"]
            if item["seg"]["start"] - anchor_start <= time_window:
                clusters[-1].append(item)
            else:
                clusters.append([item])

        # From each cluster keep the best-scored
        for cluster in clusters:
            best = max(cluster, key=lambda x: x["score"])
            result.append(best)

    return result

# ── Transcription & silence removal (background tasks) ───────────────────────

def _do_transcribe(session_id: str, file_id: str):
    import whisper
    # Ensure our local ffmpeg is on PATH so Whisper can decode m4a/mp3
    ffmpeg_dir = str(BINS_DIR)
    if ffmpeg_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    fdata = state["sessions"][session_id]["files"][file_id]
    try:
        model = whisper.load_model("base")
        result = model.transcribe(fdata["path"], word_timestamps=True)
        segments = []
        for seg in result["segments"]:
            segments.append({
                "id": seg["id"],
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"].strip(),
                "words": seg.get("words", []),
            })
        fdata["transcript"] = result["text"].strip()
        fdata["segments"] = segments
        fdata["status"] = "done"
    except Exception as e:
        fdata["status"] = "error"
        fdata["error"] = str(e)
    save_state(state)

def _do_remove_silence(session_id: str, file_id: str):
    ffmpeg = find_ffmpeg()
    fdata = state["sessions"][session_id]["files"][file_id]
    src = fdata["path"]
    out = Path(src).parent / f"{Path(src).stem}_nosilence{Path(src).suffix}"
    cmd = [
        ffmpeg, "-y", "-i", src,
        "-af",
        "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB"
        ":stop_periods=-1:stop_duration=0.3:stop_threshold=-40dB",
        str(out)
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode == 0:
        fdata["silence_removed_path"] = str(out)
        fdata["silence_removed"] = True
    else:
        fdata["silence_error"] = r.stderr.decode()
    save_state(state)

# ── Frontend ──────────────────────────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8765, reload=False)
