"use strict";
// The main process passes the page that failed as ?url= (site URLs only).
(function () {
  const url = new URLSearchParams(window.location.search).get("url");
  const retry = document.getElementById("retry");
  if (url && /^https?:\/\//.test(url)) retry.href = url;
  window.addEventListener("online", () => retry.click());
})();
