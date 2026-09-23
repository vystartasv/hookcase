(function () {
  "use strict";
  document.querySelectorAll("[data-copy-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var source = document.getElementById(button.getAttribute("data-copy-target"));
      var status = button.parentElement.querySelector(".copy-status");
      var text = source ? source.innerText.replace(/\n$/, "") : "";
      var done = function (copied) { status.textContent = copied ? "Copied" : "Select text"; button.querySelector(".copy-label").textContent = copied ? "Copied" : "Copy"; window.setTimeout(function () { status.textContent = ""; button.querySelector(".copy-label").textContent = "Copy"; }, 2400); };
      if (!text) return done(false);
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
  });
}());
