// Consent is server-rendered and stays usable without the application bundle.
const media = window.matchMedia("(prefers-color-scheme: dark)");
function applyAppearance() {
  let preference = "system";
  try {
    preference = localStorage.getItem("whiteboard-appearance") ?? "system";
  } catch {}
  document.documentElement.dataset.theme =
    preference === "dark" || (preference !== "light" && media.matches)
      ? "dark"
      : "light";
}
applyAppearance();
media.addEventListener("change", applyAppearance);
window.addEventListener("storage", (event) => {
  if (event.key === "whiteboard-appearance") applyAppearance();
});

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  if (!form) return;
  const submit = form.querySelector('button[value="allow"]');
  const choices = [...form.querySelectorAll('input[name="selection"]')];
  const update = () => {
    const selected =
      form.querySelector('input[name="resource_mode"]:checked')?.value ===
      "selected";
    for (const choice of choices) choice.disabled = !selected;
    if (submit)
      submit.disabled = selected && !choices.some((choice) => choice.checked);
  };
  form.addEventListener("change", update);
  update();
});
