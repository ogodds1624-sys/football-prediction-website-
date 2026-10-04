// Shared on every page: buttons gently pop into view when the page opens,
// one after another. Only buttons present at load pop, so tables and lists
// that re-render later don't replay it.
(function popInButtons() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const STAGGER_S = 0.07;
  const MAX_DELAY_S = 0.8;
  const buttons = document.querySelectorAll(
    // The passcode eye button is positioned with a transform, so it is left out.
    "button:not(.toggle-passcode), a.plan-button, a.admin-button, a.admin-submit, a.back-button, a.pay-whatsapp",
  );

  // Buttons inside pop-up windows (calendar, payment) appear instantly when opened.
  [...buttons].filter((button) => !button.closest("dialog")).forEach((button, index) => {
    button.style.setProperty("--pop-delay", `${Math.min(index * STAGGER_S, MAX_DELAY_S)}s`);
    button.classList.add("pop-in");
    // Hand control back to the normal hover/press effects once it has popped.
    button.addEventListener("animationend", () => button.classList.remove("pop-in"), { once: true });
  });
})();
