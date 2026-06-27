# Voice Take Editor

A free, local audio editing tool for cleaning up voice recordings. Record multiple takes of the same script, and this tool helps you pick the best version of each sentence, cut out stumbles and filler words, and export a clean final audio file — all from your browser, with no subscriptions, no uploads to the cloud, and no cost.

---

## What does it do?

When you're recording a voiceover, podcast, or narration, you usually record several takes of the same sentences. Picking the best parts from each take and stitching them together is normally slow and tedious work in a full audio editor.

This tool makes it fast:

1. **Upload your takes** — drop in as many audio files as you like
2. **Transcribe with Whisper** — a free AI transcribes everything locally on your Mac (your audio never leaves your computer)
3. **Group & Rank** — the tool finds every sentence spoken across all your takes, groups matching sentences together, and scores each version based on quality (fewer stumbles, fewer filler words, less silence)
4. **Listen and pick** — for each sentence, you see 2–3 ranked candidates with a Play button next to each. You listen and choose the one that sounds best
5. **Edit words** — click a word to select it, shift-click another word to select a range, and press Backspace to delete it. The audio skips deleted words on export
6. **Export** — one click exports your final assembly as a clean WAV file

Everything runs on your Mac. Nothing is sent anywhere. It's completely free.

---

## What you need before you start

- A **Mac** (macOS 10.15 Catalina or newer)
- **Python 3.9 or newer** — check by opening Terminal and typing `python3 --version`
- **Homebrew** — a tool that makes installing software on Mac easy (free, takes 2 minutes to install)
- Your **audio files** — `.m4a`, `.mp3`, `.wav`, or `.aiff` all work. iPhone voice memos export as `.m4a` and work perfectly

That's it. No audio software, no paid services, no accounts required.

> **A note on cost:** The transcription is powered by [OpenAI Whisper](https://github.com/openai/whisper), which is a free, open-source AI model that runs entirely on your computer. You are not using the OpenAI API and there are no charges of any kind.

---

## Installation

This only needs to be done once.

### Step 1 — Install Homebrew (if you don't have it)

Open **Terminal** (press `Cmd + Space`, type "Terminal", press Enter) and paste this:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the prompts. It will ask for your Mac password. This is normal — Homebrew needs permission to install software.

### Step 2 — Install Python (if you don't have it)

In Terminal, paste:

```bash
brew install python
```

When it finishes, check it worked:

```bash
python3 --version
```

You should see something like `Python 3.11.4`. Any version 3.9 or above is fine.

### Step 3 — Download this project

Click the green **Code** button at the top of this page on GitHub, then click **Download ZIP**. Unzip the file and move the folder somewhere convenient, like your Desktop.

Or if you have Git installed, you can clone it:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
```

### Step 4 — Run the setup script

In Terminal, navigate to the project folder. If you put it on your Desktop:

```bash
cd ~/Desktop/voice-take-editor
```

Then run the setup script:

```bash
./setup.sh
```

> If you see a "permission denied" error, run this first and then try again:
> ```bash
> chmod +x setup.sh start.sh
> ```

The setup script will:
- Download a small audio conversion tool (ffmpeg) — about 90 MB, one time only
- Create a Python environment for the project
- Install all the Python dependencies

This takes 2–5 minutes the first time. You'll see progress messages as it runs.

### Step 5 — Start the tool

```bash
./start.sh
```

You should see something like:

```
Uvicorn running on http://127.0.0.1:8765
```

Now open your browser and go to:

**[http://127.0.0.1:8765](http://127.0.0.1:8765)**

The tool is running. Leave Terminal open in the background while you use it.

> **Next time:** you only need to run `./start.sh`. The setup step is one-time only.

---

## How to use it

### 1. Upload your audio files

Drag and drop your audio files onto the upload area, or click to browse. You can upload as many takes as you like — there's no limit.

<!-- screenshot: drop zone with files being dragged in -->

### 2. Transcribe your recordings

Click **Transcribe All with Whisper**.

The first time you do this, Whisper will download its AI model — about 145 MB. This happens automatically and only happens once. After that, transcription is instant and offline.

Transcription takes roughly 1–3 minutes per 10 minutes of audio, depending on your Mac's speed. You'll see a "Transcribing…" status on each file while it works.

<!-- screenshot: takes panel with transcription in progress -->

### 3. Optional — Remove silence

If your recordings have long pauses at the start or between sentences, click **Remove Silence from All**. This cleans up the audio before assembly. It's optional but recommended.

### 4. Group and rank sentences

Once all files are transcribed, click **✦ Group & Rank Sentences**.

The tool will:
- Find every sentence across all your takes
- Group matching sentences together (even if the wording is slightly different)
- Score each version for quality

<!-- screenshot: group and rank button in the Takes section header -->

### 5. Pick the best take for each sentence

You'll see a list of **Sentence Groups**. Each group shows the same sentence spoken in different takes, ranked by quality score.

<!-- screenshot: sentence groups panel with ranked candidates -->

For each group:
- Click **▶** next to a candidate to hear just that sentence (it stops automatically at the end)
- The score (shown in green, yellow, or red) reflects quality — higher is better
- Details like "2 fillers" or "1 stumble" tell you what the scoring found

When you find the version you want, click **+ Add to Assembly**. That sentence gets added to your final assembly in order.

Or click **+ Add All to Assembly** at the top to grab the top-ranked candidate from every group at once — then go back and swap out any you want to change.

### 6. Edit words in a sentence

After adding sentences to the assembly, you can do fine-grained editing:

- **Click a word** to select it (it turns purple)
- **Shift+click another word** to select everything in between
- Press **Backspace** or **Delete** to remove the selection
- The deleted words appear crossed out and will be skipped on export

<!-- screenshot: assembly with a word selection highlighted -->

To undo word deletions, click **Restore deleted words** on that sentence.

### 7. Reorder your assembly

Grab the **⠿ handle** on the left side of any sentence and drag it up or down to reposition it.

You can also reorder the sentence groups themselves in the same way — drag the ⠿ handle on a group header to move the whole group.

### 8. Export

When you're happy with your assembly, click **⬇ Export WAV** at the top of the Assembly section.

A `.wav` file will download to your computer. The exported audio reflects exactly what you see in the assembly — deleted words are cut out, and sentences are in the order you arranged them.

---

## Stopping the tool

When you're done, go back to Terminal and press `Ctrl + C` to stop the server.

Your session is saved automatically. The next time you run `./start.sh` and open the browser, your previous files and assembly will still be there.

---

## Common problems and fixes

### "Permission denied" when running setup.sh or start.sh

```bash
chmod +x setup.sh start.sh
```

Then try again.

---

### The browser shows "This site can't be reached"

The server isn't running. Make sure you've run `./start.sh` in Terminal and that Terminal is still open. The server stops when you close Terminal.

---

### Transcription shows "Error" on a file

This usually means Whisper couldn't read the file. Try these steps:

1. Make sure the file plays normally in QuickTime Player
2. If the file is a very unusual format, try converting it to `.m4a` or `.mp3` first (you can use QuickTime: File → Export As → Audio Only)
3. Restart the server (`Ctrl+C` in Terminal, then `./start.sh` again) and try transcribing again

---

### Transcription is very slow

Whisper runs on your Mac's CPU by default, which is fine but not instant. A 5-minute recording might take 2–4 minutes to transcribe. This is normal. You can transcribe multiple files at the same time — they'll queue automatically.

---

### "No sentence groups found" after clicking Group & Rank

This can happen if:
- Only one file is transcribed (you need at least two takes of similar content for grouping to work)
- The files contain very different content with no overlapping sentences

Make sure all your files are fully transcribed (status shows "Done") before grouping.

---

### The tool stopped working after I closed and reopened Terminal

Just run `./start.sh` again. The tool needs the server running to work. Think of it like a local app — it needs to be "launched" each time.

---

### I want to start fresh with new recordings

Click **+ New Session** in the top right corner. This creates a new empty session. Your old session's files stay on disk in the `uploads/` folder but won't appear in the new session.

---

## Project structure (for the curious)

```
voice-take-editor/
├── backend/
│   └── main.py          # Python server (FastAPI + Whisper)
├── frontend/
│   ├── index.html       # The UI
│   ├── app.js           # All the browser logic
│   └── style.css        # Styling
├── bins/                # ffmpeg binary (downloaded by setup.sh, not in git)
├── uploads/             # Your audio files (not in git)
├── exports/             # Exported WAV files (not in git)
├── setup.sh             # One-time setup script
└── start.sh             # Run this each time to start the tool
```

---

## License

MIT — free to use, modify, and share.
