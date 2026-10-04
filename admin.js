const ADMIN_PASSCODE = "8057";
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (passcodeInput.value.trim() !== ADMIN_PASSCODE) {
    errorText.textContent = "Incorrect passcode. Try again.";
    passcodeInput.select();
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
