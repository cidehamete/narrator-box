// Wraps webkitSpeechRecognition for single-utterance capture.
// iOS Safari requires a user gesture before calling .start() — the pedal tap satisfies this.
export function createSTT({ onResult, onError, onEnd }) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    onError(new Error("Web Speech API not available in this browser"));
    return null;
  }

  const rec = new Rec();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = "en-US";

  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    onResult(transcript);
  };

  rec.onerror = (e) => {
    // "no-speech" is common and not a fatal error — treat it as empty input
    onError(new Error(e.error ?? "STT error"));
  };

  rec.onend = () => onEnd();

  return {
    start: () => rec.start(),
    stop:  () => rec.stop(),
    abort: () => rec.abort()
  };
}
