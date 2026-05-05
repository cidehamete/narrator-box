// On-screen debug log. Tap the app title three times quickly to reveal.
const MAX_LINES = 120;
const lines = [];

export function dbg(msg) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `${ts} ${msg}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();

  const el = document.getElementById("debug-log");
  if (el) {
    el.textContent = lines.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  // Mirror to real console too
  console.log("[NB]", msg);
}

export function initDebugPanel() {
  let taps = 0;
  let tapTimer = null;

  document.querySelector(".app-title")?.addEventListener("click", () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 600);
    if (taps >= 3) {
      taps = 0;
      document.getElementById("debug-panel").classList.toggle("hidden");
    }
  });

  document.getElementById("debug-clear")?.addEventListener("click", () => {
    lines.length = 0;
    const el = document.getElementById("debug-log");
    if (el) el.textContent = "";
  });
}
