# Getting started

This app records a meeting, writes down what was said, tells you who said it, and summarizes it. Everything happens **on your own computer**. Nothing is uploaded, and you do not need an account or an API key.

> The first time you use it, the app downloads a few "models" (the files that do the listening and writing). This happens once and needs internet. After that it works offline.

### What you need

- A Mac with Apple Silicon (M1 or newer, macOS 13+) or a Windows 10/11 PC.
- At least 8 GB of memory and about 5 GB of free disk space.
- Headphones are a good idea so the recording does not pick up echo.

## Step 1: Open the app and follow the checklist

When you open the app you will see a **Getting started** checklist at the top of the New recording screen. It ticks itself off as you go. You can hide it and bring it back from this page.

1. **Speech model:** press **Download**. This lets the app turn speech into text. It can take a few minutes. You can keep using the app while it downloads.
2. **Summary model:** press **Download**. This writes the summary, decisions and action items. It is a bigger file (2.5 GB, or 18.6 GB on computers with 24 GB+ of memory). You can skip it and still record; you can summarize later.

## Step 2: Choose what to record

Pick the one that matches your situation.

### A. A conversation in the room, or just your own voice

Nothing to install. Leave the audio input on your microphone, tick **Several people share my microphone** if more than one person is talking, and press **Start recording**. Sit close to the microphone for the best results.

### B. A video call on a Mac (Zoom, Meet, Teams)

A Mac does not let apps record the sound of other apps, so you add a free helper called **BlackHole**. You only do this once.

1. Install it. In Terminal run:

```bash
brew install --cask blackhole-2ch
```

2. Restart the Mac's audio service (or just restart the Mac):

```bash
sudo killall coreaudiod
```

3. In **System Settings → Sound → Output**, choose **BlackHole 2ch**. (You will not hear the call while this is on. To hear it too, open **Audio MIDI Setup**, click **+**, create a **Multi-Output Device** with your speakers and BlackHole ticked, and choose that as the output instead.)
4. In this app, set **audio input** to **BlackHole 2ch (Virtual)**, untick **Capture meeting audio from a tab/screen**, and tick **Several people share my microphone** so each person is labelled.
5. Press **Test audio** while something is playing. You should see the level bar move and the message "Audio is coming in".
6. Press **Start recording**. When the call ends, press **Stop & save**, then set your Mac's sound output back to your speakers.

> Do not play the call through your speakers and let the microphone pick it up. The words come out fine, but the app cannot tell the people apart.

### C. A video call on Windows

Nothing to install. Press **Start recording**, and when the picker appears choose **Entire screen** and tick **Share system audio**. The app records everything you hear.

### D. Let a bot join for you

In **Send a bot to the meeting**, paste the Meet, Zoom or Teams link and press **Send bot**. A visible guest called "Meeting Notetaker" joins from your computer. You may need to let it in from the waiting room. If the meeting only allows signed-in people, use **Google (Meet)** or **Microsoft (Teams)** under the bot box to sign the bot in once with a spare account (never your main one).

## Step 3: Test your audio

Before an important meeting, press **Test audio** next to the audio input. It listens for 6 seconds and shows a live level bar. If it hears nothing, it tells you what to check.

## Step 4: Record

1. Type a title (optional).
2. Press **Start recording**. The transcript appears live, with a coloured name for each speaker.
3. Press **Stop & save** when finished. The app tidies up the speaker labels and, if the summary model is installed, writes the summary.

Tell everyone they are being recorded. Many places legally require consent.

## Step 5: Read the results

- **Summary:** the main points, decisions and action items with owners.
- **Transcript:** click a time to jump to that moment in the audio. Lines marked **? unsure** are ones where the app could not tell who spoke. **Review unsure** jumps through them.
- **Speakers:** press **Rename** to change "Speaker 2" to a real name. Your corrections are never overwritten.
- **Ask:** type a question like "What did we decide about the launch date?"
- **Export:** save the transcript as `.md` or `.txt`.

## Already have notes?

On the New recording screen, **Import meeting notes** accepts `.pdf`, `.docx`, `.md` and `.txt` files. You can turn them into a new meeting, or attach them to a meeting you recorded so the summary and Ask can use them. Lines like `Priya: we agreed to ship Friday` keep Priya as the speaker. PDFs must contain real text (scans are not read).

## Your privacy

- Recordings and transcripts are stored **encrypted** on this computer. The key is kept in your system keychain.
- The app only talks to the internet to download models and, if you use the bot, to reach the meeting.
- Voice fingerprints are saved only if you press **Remember voice**, and you can delete them in Settings.

## If something goes wrong

- **Nothing was recorded or the level bar does not move:** check the audio input, and that the app has microphone permission (macOS: System Settings → Privacy & Security → Microphone).
- **No summary:** download the summary model from the checklist or Settings. On a computer with less than 6 GB of memory use Ollama or a Claude key instead.
- **It is slow or lagging:** close other heavy apps. The app picks a smaller speech model on its own if it cannot keep up.
- **Speakers are mixed up:** use a loopback device or the bot instead of a room microphone, then fix a few names with **Rename**.
- **The bot cannot join:** the meeting may require sign-in or a host to admit guests. Press **Show bot window** to see what it is waiting on.
- **The recording was cut off:** the app saves as it goes. Reopen the meeting; everything captured up to that point is kept and marked as interrupted.
