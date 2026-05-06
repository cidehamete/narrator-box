// Wraps webkitSpeechRecognition for tap-to-start / tap-to-stop use on iOS.
// iOS does not fire onResult after stop() — so we run continuous with interimResults
// and snapshot the best transcript when the user taps to stop.
export function createSTT({ onResult, onError, onEnd }) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) {
    onError(new Error("Web Speech API not available in this browser"));
    return null;
  }

  const rec = new Rec();
  rec.continuous = true;       // keep listening until we call stop()
  rec.interimResults = true;   // surface partial results so we can snapshot them
  rec.lang = "en-US";

  let bestTranscript = "";

  rec.onresult = (e) => {
    // Accumulate the most recent final + interim transcript
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    if (transcript.trim()) bestTranscript = transcript.trim();
  };

  rec.onerror = (e) => {
    if (e.error === "aborted") return; // expected when we call stop() ourselves
    onError(new Error(e.error ?? "STT error"));
  };

  rec.onend = () => {
    const transcript = bestTranscript;
    bestTranscript = "";
    if (transcript) {
      onResult(transcript);
    } else {
      onEnd(); // nothing captured — caller resets to idle
    }
  };

  return {
    start: () => { bestTranscript = ""; rec.start(); },
    stop:  () => rec.stop(),
    abort: () => rec.abort()
  };
}
