# Voice Take Editor

A free, local audio editing tool for cleaning up voice recordings. Record multiple takes of the same script, and this tool helps you pick the best version of each sentence, cut out stumbles and filler words, and export a clean final audio file — all from your browser, with no subscriptions, no uploads to the cloud, and no cost.

Works on **Mac**, **Windows**, and **Linux**.

---

## What does it do?

When you're recording a voiceover, podcast, or narration, you usually record several takes of the same sentences. Picking the best parts from each take and stitching them together is normally slow and tedious work in a full audio editor.

This tool makes it fast:

1. **Upload your takes** — drop in as many audio files as you like
2. **Transcribe with Whisper** — a free AI transcribes everything locally on your computer (your audio never leaves your machine)
3. **Group & Rank** — the tool finds every sentence spoken across all your takes, groups matching sentences together, and scores each version based on quality (fewer stumbles, fewer filler words, less silence)
4. **Listen and pick** — for each sentence, you see ranked candidates with a Play button. You listen and choose the one that sounds best
5. **Edit words** — click a word to select it, shift-click another word to select a range, and press Backspace to delete it. The audio skips deleted words on export
6. **Adjust timing** — reorder lines by dragging, and control the silence gap between each line with − / + buttons
7. **Export** — one click exports a ZIP file containing a clean WAV and a matching SRT subtitle file

Everything runs on your own computer. Nothing is sent anywhere. It's completely free.

> **A note on cost:** The transcription is powered by [OpenAI Whisper](https://github.com/openai/whisper), which is a free, open-source AI model that runs entirely on your computer. You are **not** using the OpenAI API and there are **no charges of any kind**.

---

## What you need before you start

- **Mac**, **Windows 10/11**, or **Linux**
- **Python 3.9 or newer** — most Macs and Linux machines already have this; Windows users will install it in the steps below
- Your **audio files** — `.m4a`, `.mp3`, `.wav`, or `.aiff` all work. iPhone voice memos export as `.m4a` and work perfectly

That's it. No audio software, no paid services, no accounts required.

---

## Installation

Pick your operating system:

- [Mac](#installation-mac)
- [Windows](#installation-windows)
- [Linux](#installation-linux)

---

## Installation — Mac

### Step 1 — Install Homebrew

Homebrew is a free tool that makes installing software on Mac easy. If you already have it, skip to Step 2.

Open **Terminal** (press `Cmd + Space`, type "Terminal", press Enter) and paste this:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It will ask for your Mac password. This is normal — type it in and press Enter (you won't see the characters as you type, that's fine too).

### Step 2 — Install Python

In Terminal:

```bash
brew install python
```

Check it worked:

```bash
python3 --version
```

You should see something like `Python 3.11.4`. Any version 3.9 or above is fine.

### Step 3 — Download this project

Click the green **Code** button at the top of this GitHub page and choose **Download ZIP**. Unzip it and move the folder somewhere you'll remember, like your Desktop.

Or, if you have Git installed:

```bash
git clone https://github.com/phillipjohnsen-ai/voice-take-editor.git
```

### Step 4 — Run the setup script

In Terminal, navigate to the project folder. If you put it on your Desktop:

```bash
cd ~/Desktop/voice-take-editor
```

Then run:

```bash
./setup.sh
```

> If you see "permission denied", run this first, then try again:
> ```bash
> chmod +x setup.sh start.sh
> ```

The script will download a small audio conversion tool (ffmpeg, ~90 MB, one-time only), create a Python environment, and install all the dependencies. This takes 2–5 minutes.

### Step 5 — Start the tool

```bash
./start.sh
```

You'll see:

```
Uvicorn running on http://127.0.0.1:8765
```

Open your browser and go to **http://127.0.0.1:8765**

Leave Terminal open while you use the tool. To stop it, press `Ctrl + C`.

> **Next time:** just run `./start.sh`. The setup step is one-time only.

---

## Installation — Windows

### Step 1 — Install Python

Go to **https://www.python.org/downloads/** and download the latest Python 3 installer.

Run the installer. **Important:** on the first screen, check the box that says **"Add Python to PATH"** before clicking Install. If you miss this, the commands below won't work.

To check it worked, open **Command Prompt** (press `Win + R`, type `cmd`, press Enter) and run:

```
python --version
```

You should see something like `Python 3.11.4`.

### Step 2 — Download this project

Click the green **Code** button at the top of this GitHub page and choose **Download ZIP**. Unzip it and move the folder somewhere you'll remember, like your Desktop.

### Step 3 — Run the setup script

Open **Command Prompt** and navigate to the project folder. If you put it on your Desktop:

```
cd %USERPROFILE%\Desktop\voice-take-editor
```

Then run:

```
setup.bat
```

The script will:
- Install ffmpeg automatically using Windows' built-in `winget` tool
- Create a Python environment
- Install all the Python dependencies

This takes a few minutes the first time. Just let it run.

> If winget can't install ffmpeg automatically, the script will give you step-by-step manual instructions.

### Step 4 — Start the tool

In Command Prompt, from the project folder:

```
start.bat
```

You'll see:

```
Uvicorn running on http://127.0.0.1:8765
```

Open your browser and go to **http://127.0.0.1:8765**

Leave Command Prompt open while you use the tool. To stop it, press `Ctrl + C`.

> **Next time:** just run `start.bat`. The setup step is one-time only.

---

## Installation — Linux

These instructions work on Ubuntu, Debian, Fedora, Arch, and most other distributions.

### Step 1 — Check Python

Open a terminal and run:

```bash
python3 --version
```

If you see Python 3.9 or above, you're good. If not, install it with your package manager:

```bash
# Ubuntu / Debian
sudo apt install python3 python3-pip python3-venv

# Fedora
sudo dnf install python3

# Arch
sudo pacman -S python
```

### Step 2 — Download this project

```bash
git clone https://github.com/phillipjohnsen-ai/voice-take-editor.git
cd voice-take-editor
```

Or download the ZIP from the green **Code** button at the top of this page, unzip it, and open a terminal in that folder.

### Step 3 — Run the setup script

```bash
chmod +x setup.sh start.sh
./setup.sh
```

The script will automatically install ffmpeg using your system's package manager (apt, dnf, yum, or pacman), create a Python environment, and install all dependencies.

### Step 4 — Start the tool

```bash
./start.sh
```

You'll see:

```
Uvicorn running on http://127.0.0.1:8765
```

Open your browser and go to **http://127.0.0.1:8765**

Leave the terminal open while you use the tool. To stop it, press `Ctrl + C`.

> **Next time:** just run `./start.sh`. The setup step is one-time only.

---

## How to use it

### 1. Upload your audio files

Drag and drop your audio files onto the upload area, or click to browse. You can upload as many takes as you like — there's no limit.

<!-- screenshot: drop zone with files being dragged in -->

### 2. Process your recordings

Click **▶ Process & Group Everything**.

This does two things in one step: transcribes all your files with Whisper, then groups and ranks every sentence.

The first time you run this, Whisper will download its AI model — about 145 MB. This happens automatically and only happens once. After that, transcription is fully offline.

Processing takes roughly 1–3 minutes per 10 minutes of audio. You'll see progress status on each file while it works.

### 3. Group and rank sentences

Once processing finishes, click **✦ Group & Rank** if you want to re-run grouping after making changes.

The tool will:
- Find every sentence across all your takes
- Group matching sentences together (even if the wording is slightly different between takes)
- Score each version for quality

<!-- screenshot: sentence groups panel with ranked candidates -->

### 5. Pick the best take for each sentence

You'll see a list of **Sentence Groups**. Each group shows the same sentence spoken in different takes, ranked by quality score.

For each group:
- Click **▶** next to a candidate to hear just that sentence (it stops automatically at the end)
- The score (shown in green, yellow, or red) reflects quality — higher is better
- Details like "2 fillers" or "1 stumble" tell you what the scoring found

When you find the version you want, click **+ Add to Assembly**. That sentence gets added to your final assembly in order.

Or click **+ Add All to Assembly** at the top to grab the top-ranked candidate from every group at once — then go back and swap any you want to change.

### 6. Edit words in a sentence

After adding sentences to the assembly, you can do fine-grained editing:

- **Click a word** to select it (it turns purple)
- **Shift+click another word** to select everything in between
- Press **Backspace** or **Delete** to remove the selection
- The deleted words appear crossed out and will be skipped on export

<!-- screenshot: assembly with a word selection highlighted -->

To undo word deletions on a sentence, click **Restore deleted words**.

### 7. Reorder your assembly

Grab the **⠿ handle** on the left side of any sentence and drag it up or down to reposition it.

You can also reorder the sentence groups themselves the same way — drag the ⠿ handle on a group header to move the whole group up or down.

### 8. Preview and adjust spacing

Click **▶ Play All** in the assembly header to hear all lines play back in sequence with the correct gaps between them.

Between each pair of lines you'll see a gap control:
- **−** reduces the silence between those two lines (100ms steps)
- **+** increases it
- **↺** resets to the default (80ms)

The gap is tied to the position between lines, so it stays put when you reorder.

### 9. Export

When you're happy with your assembly, click **⬇ Export ZIP**.

A `.zip` file will download containing:
- A `.wav` file — the final mixed audio with all your edits applied
- A `.srt` file — subtitle timestamps matching the assembly, ready for video editors

The exported audio reflects exactly what you see in the assembly — deleted words are cut out, gaps are the sizes you set, and sentences play in the order you arranged them.

---

## Stopping the tool

Press `Ctrl + C` in your terminal or Command Prompt window.

Your session ID is saved in the browser so the server reconnects automatically next time. Note: your assembly and word edits live in the browser's memory — if you hard-refresh the page you will need to re-process your files.

---

## Common problems and fixes

### "Permission denied" when running setup.sh or start.sh (Mac / Linux)

```bash
chmod +x setup.sh start.sh
```

Then try again.

---

### The browser shows "This site can't be reached"

The server isn't running. Make sure you've run `./start.sh` (Mac/Linux) or `start.bat` (Windows) and that the terminal window is still open. The server stops when you close the terminal.

---

### Transcription shows "Error" on a file

This usually means Whisper couldn't read the file format. Try these steps:

1. Make sure the file plays normally in your default media player
2. If the file is an unusual format, convert it to `.mp3` first — on Mac you can use QuickTime (File → Export As → Audio Only), on Windows use VLC (Media → Convert/Save)
3. Restart the server (`Ctrl + C`, then start it again) and try transcribing again

---

### Transcription is very slow

Whisper runs on your computer's CPU, which is fine but not instant. A 5-minute recording might take 2–4 minutes to transcribe. This is normal. You can kick off transcription on multiple files at the same time — they'll queue automatically.

---

### "No sentence groups found" after clicking Group & Rank

This happens if:
- Only one file is transcribed (you need at least two takes with overlapping sentences for grouping to work)
- The files contain very different content with no repeated sentences

Make sure all your files show "Done" status before running Group & Rank.

---

### ffmpeg not found (Windows)

If `setup.bat` couldn't install ffmpeg automatically, install it manually:

1. Go to **https://www.gyan.dev/ffmpeg/builds/**
2. Download **ffmpeg-release-essentials.zip**
3. Unzip the file
4. Inside the unzipped folder, open the `bin` folder and find `ffmpeg.exe`
5. Copy `ffmpeg.exe` to `C:\Windows\System32\`
6. Restart Command Prompt and run `setup.bat` again

---

### The tool stopped working after I closed and reopened my terminal

Just start it again — `./start.sh` on Mac/Linux, `start.bat` on Windows. The tool needs the server running to work. Think of it like a local app that needs to be launched each time.

---

### I want to start fresh with new recordings

Click **+ New Session** in the top right corner. This creates a new empty session. Your old files stay on disk but won't appear in the new session.

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
├── setup.sh             # One-time setup for Mac / Linux
├── setup.bat            # One-time setup for Windows
├── start.sh             # Launch the tool on Mac / Linux
└── start.bat            # Launch the tool on Windows
```

Folders created automatically (not included in the repository):
- `bins/` — ffmpeg binary (downloaded by setup on Mac)
- `uploads/` — your audio files
- `exports/` — exported ZIP files (WAV + SRT)

---

## License

MIT — free to use, modify, and share.
