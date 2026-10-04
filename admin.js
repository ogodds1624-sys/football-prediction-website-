// The passcode is checked by the server (ADMIN_PASSCODE setting), never stored here.
const SESSION_KEY = "predictions-admin";
const CONTROL_ROOM = "control-room.html";

const form = document.querySelector("#admin-form");
const passcodeInput = document.querySelector("#passcode");
const toggleButton = document.querySelector("#toggle-passcode");
const errorText = document.querySelector("#admin-error");

function isSignedIn() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "yes";
  } catch {
    return false;
  }
}

toggleButton.addEventListener("click", () => {
  const show = passcodeInput.type === "password";
  passcodeInput.type = show ? "text" : "password";
  toggleButton.setAttribute("aria-pressed", String(show));
  toggleButton.setAttribute("aria-label", show ? "Hide passcode" : "Show passcode");
});

passcodeInput.addEventListener("input", () => {
  errorText.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorText.textContent = "";
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: passcodeInput.value.trim() }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorText.textContent = body.error || "Couldn't sign in. Please try again.";
      passcodeInput.select();
      return;
    }
  } catch {
    errorText.textContent = "Can't reach the server. Check your connection and try again.";
    return;
  }

  try {
    sessionStorage.setItem(SESSION_KEY, "yes");
  } catch {
    errorText.textContent = "Your browser is blocking storage, so the control room can't open.";
    return;
  }
  location.href = CONTROL_ROOM;
});

if (isSignedIn()) {
  location.replace(CONTROL_ROOM);
}
