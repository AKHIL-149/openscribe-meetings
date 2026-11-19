# Privacy: where your data goes

**By default nothing you record leaves your computer.** This page lists every place data is stored or sent, so you can check it.

## What is stored, and where
All of it is in the app's data folder (`~/Library/Application Support/meeting-recorder` on macOS, `%APPDATA%\meeting-recorder` on Windows), encrypted with AES-256 (the key is held by the macOS Keychain / Windows DPAPI): transcripts, summaries, recordings, voiceprints (only if you press "Remember voice"), settings and any cloud keys you add.
Not encrypted, by design: downloaded model files (public), and `bot-steps.log` (see below).

## What is sent over the network
| When | What is sent | Where |
| --- | --- | --- |
| First use of a feature | Nothing about you: a download request for a public model file | huggingface.co (speech, speaker and summary models), github.com (speaker model) |
| The built-in bot joins a meeting | Normal web traffic of a guest joining the call, because it is a participant | The meeting site (Google, Microsoft, Zoom) |
| You add a Deepgram / Anthropic / Recall.ai key **and select it** | Audio or transcript text | That provider. Off unless you set the key |
| Anything else | **Nothing.** The app window is technically blocked from contacting any address except your own computer, and there is no telemetry, analytics, crash upload or auto-update |  |

## Logs
- Normal logs contain no transcript text, names, links or audio. Debug mode (`MR_DEBUG=1`) logs only lengths; transcript text is logged only if you also set `MR_DEBUG_TEXT=1`. Do not share such a log.
- `bot-steps.log` (in the data folder) records which join step the bot is on (for example "waiting"), never links, names or content. It is capped at 200 KB.

## Bot sign-in (optional)
Some meetings only admit signed-in people. If you choose to sign the bot in, **you type the password yourself** in a normal browser window; the app never reads, types or stores it. Only the site's session cookie is kept, in a separate bot profile on this computer (Chromium protects cookie values with the OS keychain). Use a dedicated bot account, not a personal one. "Forget bot sign-in" deletes it.

## The source repository
The repository contains code only. `.gitignore` excludes `data/`, `.env`, logs, key files, recordings and models, and `npm run check:private` refuses to pass if such a file is staged.

## Not covered
Someone using your unlocked computer can open the app. If you lose the OS keychain entry, encrypted data cannot be recovered. People in a meeting can see the bot's name. Tell participants they are being recorded.
