"use strict";

(function () {
  const elapsed = document.getElementById("elapsed");
  const stop = document.getElementById("stop");
  const started = Date.now();

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  function tick() {
    const total = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    elapsed.textContent = h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }
  tick();
  setInterval(tick, 1000);

  stop.addEventListener("click", () => {
    window.shareBar.stop();
  });
})();
