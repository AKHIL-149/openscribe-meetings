// Runs inside the guest-bot window BEFORE the meeting page's own scripts (contextIsolation is off for this
// window only, and it never loads our app's pages). It listens in on the call's audio: every remote audio
// track that WebRTC delivers is mixed to mono 16 kHz PCM and sent to the main process in 100 ms frames.
// The bot has no microphone or camera: the page is shown a *virtual* silent microphone and black camera (so
// Meet/Teams/Zoom let it reach the join screen), the bot switches both off before joining, and the real
// devices are never opened. Nothing it could send contains any sound or picture.
const { ipcRenderer } = require('electron');

(() => {
  const OUT_RATE = 16000, FRAME = 1600;
  const seen = new Set();
  let ctx = null, mix = null, frame = new Int16Array(FRAME), n = 0, tracks = 0;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    mix = ctx.createGain();
    const proc = ctx.createScriptProcessor(2048, 1, 1); // simple and works under any page CSP (no worklet module needed)
    const silent = ctx.createGain();
    silent.gain.value = 0; // the processor must be connected to run, but we never play anything
    mix.connect(proc); proc.connect(silent); silent.connect(ctx.destination);
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        frame[n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (n === FRAME) { ipcRenderer.send('bot:audio', frame.buffer.slice(0)); n = 0; }
      }
    };
    ctx.resume().catch(() => {});
  }

  function addTrack(track) {
    if (!track || track.kind !== 'audio' || seen.has(track.id)) return;
    seen.add(track.id);
    try {
      ensure();
      ctx.createMediaStreamSource(new MediaStream([track])).connect(mix);
      tracks++;
      ipcRenderer.send('bot:tracks', tracks);
    } catch (e) { seen.delete(track.id); }
  }

  // 1) WebRTC: wrap RTCPeerConnection so every incoming audio track is tapped (Meet, Teams, Zoom's web client).
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    const Wrapped = function (...args) {
      const pc = new Orig(...args);
      pc.addEventListener('track', (e) => addTrack(e.track));
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
    window.webkitRTCPeerConnection = Wrapped;
  }

  // 2) Media elements playing a MediaStream (some clients attach the call audio this way).
  setInterval(() => {
    for (const el of document.querySelectorAll('audio, video')) {
      const s = el.srcObject;
      if (s && typeof s.getAudioTracks === 'function') s.getAudioTracks().forEach(addTrack);
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, 1000);

  // 3) Virtual devices. The page asks for a mic/camera; hand it a silent audio track and a black video track.
  try {
    const md = navigator.mediaDevices;
    if (md) {
      let silent = null, black = null;
      const fakeStream = (c) => {
        const tracks = [];
        if (c && c.audio) {
          silent = silent || (() => { const a = new (window.AudioContext || window.webkitAudioContext)(); return a.createMediaStreamDestination(); })();
          tracks.push(...silent.stream.getAudioTracks().map((t) => t.clone()));
        }
        if (c && c.video) {
          black = black || (() => { const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 640, 360); return cv.captureStream(1); })();
          tracks.push(...black.getVideoTracks().map((t) => t.clone()));
        }
        return new MediaStream(tracks);
      };
      md.getUserMedia = (c) => Promise.resolve(fakeStream(c));
      const dev = (kind, id, label) => ({ kind, deviceId: id, groupId: 'notetaker', label, toJSON() { return { kind, deviceId: id, groupId: 'notetaker', label }; } });
      md.enumerateDevices = () => Promise.resolve([dev('audioinput', 'default', 'Notetaker (silent)'), dev('audiooutput', 'default', 'Notetaker (silent)'), dev('videoinput', 'notetaker-cam', 'Notetaker (off)')]);
    }
  } catch (e) { /* keep going: audio tapping above does not depend on this */ }
})();
