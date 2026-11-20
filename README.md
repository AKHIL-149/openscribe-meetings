# Meeting Recorder

A private, Otter.ai-style meeting recorder that **runs on your own computer**. It records Google Meet, Zoom, Teams, Webex or anything else, transcribes it live with a speech model on your machine, writes summaries / decisions / action items with a local language model, and stores everything encrypted.

No account, no subscription, and by default no audio or text leaves your computer.

## What runs where

| Job | Default (on your device) | Optional cloud upgrade |
| --- | --- | --- |
| Transcription | **Whisper** via ONNX Runtime. The app picks the best model for your hardware (large-v3-turbo → small → base → tiny) and steps down by itself if it can't keep up | Deepgram (adds automatic speaker labels) |
| Summaries, action items, "Ask your meeting" | **A bundled model that runs inside the app** (llama.cpp): one click in Settings downloads an open Qwen3 model sized for your RAM (30B-A3B on 24 GB+, 4B otherwise), checksum-verified. If you already run **Ollama**, its largest model that fits is used instead | Claude (Anthropic API) |
| Who is speaking | **TitaNet** voice fingerprints + **pyannote** segmentation (sherpa-onnx), ~44 MB downloaded once | Deepgram diarization |
| Meeting bot that joins calls for you | **Built-in guest bot** (desktop app): joins the link from your computer, listens, transcribes live on-device | Recall.ai (browser version only) |

**No API key is required for anything.** Deepgram, Claude and Recall.ai are optional upgrades you can ignore.

**New to this?** Open the app and use the **Getting started** checklist on the first screen, or read the [beginner guide](public/getting-started.md) (also in the app under **? Help & getting started**). It covers setup, recording a call on Mac or Windows, and reading the results in plain language.

## System requirements

| | Minimum (works, slower) | Recommended |
| --- | --- | --- |
| **Operating system** | macOS 13 (Ventura) or newer on **Apple Silicon (M1 or newer)**, or Windows 10/11 **64-bit** | The latest macOS / Windows 11 |
| **Processor** | 4 cores (uses the smaller Whisper models) | Apple Silicon with 8+ cores, or a 12+ core PC (uses Whisper large-v3-turbo) |
| **Memory (RAM)** | **8 GB.** The bundled 4B summary model needs at least 6 GB free of what the computer has | **16 GB** for the best speech model; **24 GB or more** for the best summary model (Qwen3 30B-A3B) |
| **Free disk space** | About **5 GB**: app ≈ 0.7 GB installed, speech model 40–900 MB, speaker model 44 MB, 4B summary model 2.5 GB | About **25 GB** if you use the 30B summary model (18.6 GB download) |
| **Per recording** | About **1 MB of audio per minute** (≈ 60 MB per hour), stored encrypted | |
| **Internet** | Only for the one-time model downloads and for the guest bot to reach the meeting. Transcription, speaker recognition and summaries then run offline | |
| **Audio input** | A microphone, or on **macOS** a free loopback device ([BlackHole](https://existential.audio/blackhole/)) to record the other side of a call. Windows captures system audio itself | |

Not supported: Intel Macs for on-device transcription (the speech runtime has no Intel-Mac build; they can still use a Deepgram key), 32-bit Windows, and Linux installers (Linux can run the browser version, see below, with Node.js 20.6 or newer).

How the app adapts: it measures your RAM and cores on first run, starts with the best speech model the machine should keep up with, and steps down by itself if it falls behind during a call. The summary model is picked by RAM (30B at 24 GB+, 4B at 6 GB+, otherwise summaries need Ollama or a Claude key).

**What these numbers are based on.** The model choices come from the app's own rules (`local.js`, `builtin-llm.js`). The speed and quality results in this README were measured on one machine, a MacBook Pro with an M1 Max and 64 GB of RAM. The minimum row is the app's cut-off, not something I have run on an 8 GB or 4-core computer, and the Windows installer has been built but never run, so treat both as unverified.

## Who is speaking (speaker recognition)

Every line of the transcript is labelled with *who* said it, on your computer, with no cloud service.

- **Live labels.** Each utterance is fingerprinted (NVIDIA TitaNet voice embeddings via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) and matched to the voices heard so far: Speaker 1, Speaker 2, … A "🎙 now speaking" bar and per-speaker colours show who is talking.
- **Turn-taking inside an utterance.** A pyannote segmentation model splits quick back-and-forth replies (no pause between speakers) into separate lines and detects people talking over each other.
- **Honest about being unsure.** Every label carries a confidence. When the voice is not clearly closest to one speaker (cross-talk, a one-word reply, noisy audio) the line is marked **? unsure** instead of guessing silently. **Review N unsure** jumps through them and you fix a line with one click. Your corrections are final and are never overwritten.
- **Cleaned up after the meeting.** When you stop, every line is re-compared against the final voice profiles, duplicate speakers are merged and early mistakes fixed.
- **Remember voices.** Rename "Speaker 2" to "Priya", press **Remember voice**, and later meetings label her automatically. Voiceprints are biometric data: they are stored only on this computer in the encrypted vault, only when you press the button (get the person's consent), and can be deleted in Settings.
- **Characterization.** Each meeting shows every speaker's talk time, share, turns and words, and the summary says what each person did and committed to. Action items are never assigned to someone based only on "unsure" lines.
- **In-person meetings:** tick *Several people share my microphone* so the mic channel is separated into speakers too. Otherwise the mic is labelled **You** and the meeting audio is split into speakers.

**Real-recording result.** On a 41-minute CC-BY-SA panel recording (a host plus five panelists, room microphone, MP3), the app found 5 speakers with plausible talk shares (32/23/21/12/12%) and marked 21% of lines "unsure". It did not find all of the voices separately, so two similar voices were probably merged, and there is no hand-checked ground truth. An earlier version split this recording into 82 speakers; the end-of-meeting cleanup now decides the number of people from the data (and re-runs every ~15 lines during the meeting), because real voices score much lower than clean ones. Expect to rename or fix a few lines.

**Same recording, three ways in** (HPR1064 panel, 41 minutes, same code):

| How the audio reached the app | Speakers found | Lines marked unsure |
| --- | --- | --- |
| Digital file fed in directly | 5 | 21% |
| **macOS loopback (BlackHole)**, the recommended way to record a call | **6** (24/23/22/13/12/6%) | 23% |
| Played through speakers, recorded by the MacBook microphone | about 2 for the panel part | most of its lines |

Clean digital audio works; audio picked up by a room microphone does not separate people well, because echo and room sound blur each voice's fingerprint. For calls on macOS use the loopback route. There is no hand-checked ground truth for any of these, so the speaker counts show separation, not measured accuracy.

Clean-audio test (measured with 4 distinct synthetic voices, which are cleaner than real life): 20/20 lines labelled correctly in a conversation with short replies, 0 dB noise, instant handovers and real cross-talk, every "certain" label correct, both cross-talk moments flagged. Real people and real rooms will be harder; expect more "unsure" lines, which is the intended behaviour. Limits: it does not separate two people speaking *at the same moment* (it flags the line instead); a person who speaks once for a few seconds may be folded into a similar-sounding speaker (flagged); and very similar voices can be confused.

## Install the desktop app

Installers are built into `dist-3/` (earlier builds are in `dist/` and `dist-2/`). These were built **before** the latest changes (improved speaker recognition, the sign-in option, privacy hardening and notes import), so run `npm run dist:mac` / `npm run dist:win` for a build that includes them, or start from source with `npm run desktop`:

- **macOS (Apple Silicon M1 and newer):** `Meeting Recorder-1.0.0-arm64.dmg`
- **Windows 10/11 (64-bit):** `Meeting Recorder Setup 1.0.0.exe`

Intel Macs are not supported for on-device transcription (the speech runtime has no Intel-Mac build). They can still use the app with a Deepgram key.

**First run**

1. Open the app. Click **⚙ Settings**. It shows your hardware and which models it chose.
2. *Speech:* nothing to do. The model (40 MB – 900 MB depending on your hardware) downloads on first use; **Download now** does it ahead of time.
3. *Summaries:* click **Download the summary model** in Settings (2.5 GB or 18.6 GB depending on your RAM, once). Nothing else to install. If you already run [Ollama](https://ollama.com) with a model, the app uses that automatically.

Unsigned builds show a warning the first time (macOS: right-click → Open; Windows SmartScreen: More info → Run anyway). Removing it needs an Apple Developer ID and a Windows code-signing certificate; see the secrets in `.github/workflows/build.yml`.

### Capturing the call

Click **New recording → Start recording**.

- **Windows:** the app captures everything you hear (any app, any browser) automatically.
- **macOS:** Electron cannot capture system audio, and the "Share This Window" screen picker brings no sound (it can also fail with "Timeout starting video source"). Pick one:
  - use the **meeting bot** (below), or
  - install a free loopback device such as [BlackHole](https://existential.audio/blackhole/) (`brew install --cask blackhole-2ch`, then restart the audio service with `sudo killall coreaudiod` or reboot), set your Mac's sound **output** to *BlackHole 2ch*, untick *Capture meeting audio from a tab/screen*, tick *Several people share my microphone*, and choose *BlackHole 2ch* under *audio input*. The app then labels each person separately. You will not hear the call while output is on BlackHole; for that, create a Multi-Output Device in Audio MIDI Setup (speakers + BlackHole) and use it as output.
  - Do not rely on the speakers-into-microphone route: it works for text but separates people badly (see the table above).
- **In a browser (no install):** pick the Chrome tab with the meeting and tick *Share tab audio*.

Use headphones to avoid echo. macOS asks for Microphone permission the first time.

## How your data is protected

- **Encrypted at rest.** Transcripts, summaries, settings (including API keys) and recordings are encrypted on disk: AES-256-GCM for records (tampering is detected), AES-256-CTR for audio (still seekable for playback).
- **The key is held by your OS.** In the desktop app the master key is protected by the macOS Keychain / Windows DPAPI (Electron `safeStorage`) and is only in memory while the app runs. If the key can't be read, the app refuses to start rather than creating a new key, so your data is never orphaned.
- **Browser/CLI mode:** the key is a `0600` file next to the data. That stops casual copying but not someone who can read both, so also turn on FileVault / BitLocker.
- **Local only.** The server listens on `127.0.0.1`, rejects other `Host` headers (DNS-rebinding guard) and cross-site WebSocket connections. API keys are never sent back to the page (only masked).
- Existing plaintext data from older versions is encrypted automatically on first start.
- Model files are public and are not encrypted. Data lives in `~/Library/Application Support/meeting-recorder` (macOS) or `%APPDATA%\meeting-recorder` (Windows).

Not covered: someone with your unlocked, logged-in session can open the app. **Losing the key means losing the data** (Keychain reset, or reinstalling the OS without a backup of the Keychain); there is no recovery.

## Meeting bot (built in, no account or key)

Paste a Meet, Zoom or Teams link under **Send a bot to the meeting**. A private browser window on your computer joins as a visible guest (named "Meeting Notetaker", with no microphone or camera), listens to the call's audio, and the same on-device Whisper + speaker recognition used for normal recordings produces a live transcript. It also works on macOS, where the app cannot capture system audio.

- **No microphone or camera.** The bot never uses either. Meet makes every guest answer "Allow microphone and camera?" before it shows "Ask to join", so the bot presses that button and its private browser denies the request; it then joins with both off and transmits nothing. It only listens to the call's audio.
- **Status** is shown live (joining, waiting room, in the call and recording). The host may have to admit the bot. **Show bot window** opens it so you can click through anything the automation can't (for example a human-verification check); **Make bot leave** ends it. The bot also leaves when the meeting ends, when the host removes it, or after 10 minutes of silence.
- **Privacy:** the bot window uses a temporary profile (no cookies or sign-ins are kept). Audio is processed on this computer; the call's audio is transcribed but **not saved** (only the transcript). Tell participants it is there; the bot's name is visible to everyone.
- **Honest limits:** it drives the meeting websites like a person would, and those sites change. Selectors are text-based and best effort. Meetings that require signing in (some company Meet/Teams/Zoom settings) cannot be joined as a guest. Zoom's web client and Teams are the least tested. It was verified end to end against a simulated meeting (waiting room, WebRTC audio, call end), **not** against live Meet, Zoom or Teams calls.
- **Browser version (`npm start`)** has no built-in bot. It can still use Recall.ai (paid cloud bot) if you add `RECALL_API_KEY`.

## Getting started (built into the app)

- **Checklist** on the New recording screen: speech model, summary model, audio check, sample meeting, first recording. It ticks itself off from the real state and can be hidden.
- **Test audio** next to the audio input: listens for 6 seconds, shows a live level meter, and says what to fix (wrong input, nothing playing into BlackHole, microphone permission).
- **Sample meeting**: a made-up meeting with a hand-written summary, four speakers, action items and "unsure" lines, so you can explore before recording. It contains no real data and can be deleted like any meeting.
- **Help guide**: [`public/getting-started.md`](public/getting-started.md), shown inside the app.

## Import meeting notes

On the **New recording** screen, **Import meeting notes** accepts `.pdf`, `.docx`, `.md` and `.txt` files (up to 25 MB):

1. **New meeting**: the notes become a meeting, so summary, search, Ask and export all work. Lines such as `Priya: we agreed to ship Friday` keep Priya as the speaker; other lines show as "Notes".
2. **Existing meeting**: attach a notes file to a meeting you recorded. Its text is added to what the summary and Ask see (an older summary is flagged so you can regenerate it). Remove it any time with the ✕.

Files are read in memory on this computer and never sent anywhere. PDFs must contain real text; scanned pages (pictures) are not read.

## If something goes wrong mid-meeting

Recordings are written to disk **while** you record, so a crash, force-quit, sleep or dead battery loses seconds, not the meeting.

- **Audio** is saved (encrypted) in 3-second chunks as it is captured, and each chunk is flushed to disk. Uploads are numbered and retried, so a hiccup never leaves a hole.
- **The transcript** is saved line by line.
- **If the live connection drops** (sleep/wake, network), the page reconnects by itself. While it is down the audio is buffered and sent afterwards, in order, so the transcript catches up with correct timestamps. A warning shows meanwhile. A recording session only ends when you press Stop, or after 2 minutes with no reconnection.
- **If the app dies,** the next launch finds the unfinished meeting, keeps everything captured, and marks it **⚠ interrupted** (the audio may end abruptly). Nothing is discarded.
- If you press Stop while the connection is down, the app waits briefly for it to return so the end of the meeting is not lost.

Tested by force-killing the app mid-recording (the relaunch recovered the transcript and about 40 s of valid audio), by cutting the live connection mid-sentence, and by exercising the upload rules (retry, gap, size mismatch).

## Testing safely (for developers)

Automated runs **never touch your real data.** `electron/main.js` refuses to run a test (`MR_SMOKE` / `MR_E2E_SCRIPT`) unless `MR_USER_DATA` points at a throwaway folder, and `scripts/e2e-electron.mjs` creates one, launches the real Electron binary, and only ever stops the process it started:

```bash
node scripts/e2e-electron.mjs path/to/page-script.js [path/to/app-binary] [--keep] [--kill-when-audio-bytes N]
```

`--kill-when-audio-bytes` simulates a crash by force-killing the test app once enough audio is on disk. Never delete `~/Library/Application Support/meeting-recorder` or kill the app by name while testing: that is where real meetings live.

## Run it in a browser instead

```bash
npm install
npm start                 # http://127.0.0.1:3000   (Chrome or Edge)
```

Optional settings can go in `.env` (see `.env.example`) or the in-app Settings screen.

## Build the installers yourself

```bash
npm run dist:mac      # DMG (Apple Silicon), run on a Mac
npm run dist:win      # NSIS installer (x64)
npm run desktop       # run the desktop app without installing (needs Node.js on PATH)
```

`.github/workflows/build.yml` builds both on GitHub Actions. The build downloads an official, checksum-verified Node.js binary and bundles it: the speech runtime crashes inside Electron's own runtime, so it runs as a separate process under real Node. (That also means a crash in the speech engine can't take the app down.)

## How it works

```
Browser / Electron window (public/app.js)
  mic ──► AudioWorklet ─PCM16, channel 0 "You"──┐
  meeting audio ─► AudioWorklet ─channel 1 "Others"┤  WebSocket
  MediaRecorder (opus) ── PUT ──► encrypted audio    ▼
                                      server.js ── Segmenter (pause detection)
                                           │            └► local-worker.js (Whisper, separate process)
                                           ├── vault.js   AES-256 encryption, OS-keychain key
                                           └── llm.js     Ollama (or Claude) → summary / Ask
```

Speech is cut into utterances at pauses (~0.8 s), so text appears a few seconds behind the speaker, in sentence-sized pieces rather than word by word.

## Limits

- The speaker-recognition model (NVIDIA TitaNet-small) is downloaded from the sherpa-onnx release. Its code is Apache-2.0, but **check the model's own license** (I could not confirm it for the *small* variant) before commercial distribution. The segmentation model is MIT.
- Transcription accuracy depends on audio quality and the model tier; a slower computer gets a smaller model.
- Speaker separation needs clean audio (a loopback device or the bot), not a room microphone.
- Local summaries are only as good as your local model. Very long meetings are summarized in parts.
- No accounts, sharing, or calendar auto-join.
- Tell participants they're being recorded; many places legally require consent.
