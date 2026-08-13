/**
 * Settings window.
 *
 * Changes apply live rather than behind an OK button: the wallpaper is the preview, so a control
 * that only took effect when confirmed would make tuning it guesswork.
 */
import { SETTING_RANGES, type NumericSetting, type Settings } from "@shared/settings";
import { THEMES, themeById } from "@shared/themes";

type DisplaySummary = { id: number; label: string };

type SettingsBridge = {
  read: () => Promise<{ settings: Settings; displays: DisplaySummary[]; packaged: boolean }>;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
  quit: () => void;
  close: () => void;
  onChanged: (callback: (settings: Settings) => void) => void;
};

const bridge = (globalThis as unknown as { settingsApi: SettingsBridge }).settingsApi;

const themeEl = document.getElementById("theme") as HTMLSelectElement;
const themeDescriptionEl = document.getElementById("themeDescription")!;
const coloursEl = document.getElementById("colours")!;
const slidersEl = document.getElementById("sliders")!;
const pausedEl = document.getElementById("paused") as HTMLInputElement;
const autoStartEl = document.getElementById("autoStart") as HTMLInputElement;
const displaysEl = document.getElementById("displays")!;

let displays: DisplaySummary[] = [];
let current: Settings | null = null;

function buildThemes(): void {
  for (const theme of THEMES) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.name;
    themeEl.appendChild(option);
  }
  themeEl.addEventListener("change", () => bridge.update({ themeId: themeEl.value }));
}

const colourInputs: HTMLInputElement[] = [];

/** One picker per screen. Rebuilt when the display list changes, so a new monitor gains a control. */
function buildColours(): void {
  coloursEl.replaceChildren();
  colourInputs.length = 0;

  displays.forEach((display, index) => {
    const row = document.createElement("div");
    row.className = "colour-row";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `Blob ${index + 1} — ${display.label}`;

    const input = document.createElement("input");
    input.type = "color";
    input.addEventListener("input", () => {
      if (!current) return;
      const colours = [...current.colours];
      colours[index] = input.value;
      bridge.update({ colours });
    });

    row.append(label, input);
    coloursEl.appendChild(row);
    colourInputs.push(input);
  });

  if (displays.length > 0) {
    const divider = document.createElement("div");
    divider.className = "divider";
    coloursEl.appendChild(divider);
  }
}

const outputs = new Map<NumericSetting, HTMLOutputElement>();
const inputs = new Map<NumericSetting, HTMLInputElement>();
const rows = new Map<NumericSetting, HTMLElement>();

function buildSliders(): void {
  for (const key of Object.keys(SETTING_RANGES) as NumericSetting[]) {
    const range = SETTING_RANGES[key];

    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("label");
    label.textContent = range.label;
    label.htmlFor = `slider-${key}`;

    const input = document.createElement("input");
    input.type = "range";
    input.id = `slider-${key}`;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);

    const output = document.createElement("output");

    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.textContent = `${value.toFixed(2)}×`;
      bridge.update({ [key]: value } as Partial<Settings>);
    });

    row.append(label, input, output);
    slidersEl.appendChild(row);
    inputs.set(key, input);
    outputs.set(key, output);
    rows.set(key, row);
  }
}

function render(settings: Settings): void {
  current = settings;

  const theme = themeById(settings.themeId);
  themeEl.value = theme.id;
  themeDescriptionEl.textContent = theme.description;

  colourInputs.forEach((input, index) => {
    if (document.activeElement === input) return;
    input.value = settings.colours[index] ?? "#ffffff";
  });

  for (const [key, input] of inputs) {
    // A control that has no meaning for the active theme is hidden rather than left to mislead.
    rows.get(key)!.style.display = theme.ignores.includes(key) ? "none" : "";
    // Skip whatever is being dragged, so re-rendering cannot fight the user's own input.
    if (document.activeElement === input) continue;
    input.value = String(settings[key]);
    outputs.get(key)!.textContent = `${settings[key].toFixed(2)}×`;
  }

  pausedEl.checked = settings.paused;
  autoStartEl.checked = settings.autoStart;
}

pausedEl.addEventListener("change", () => bridge.update({ paused: pausedEl.checked }));
autoStartEl.addEventListener("change", () => bridge.update({ autoStart: autoStartEl.checked }));
document.getElementById("reset")!.addEventListener("click", () => bridge.reset());
document.getElementById("quit")!.addEventListener("click", () => bridge.quit());
document.getElementById("close")!.addEventListener("click", () => bridge.close());

buildThemes();
buildSliders();
bridge.onChanged(render);

void bridge.read().then((state) => {
  displays = state.displays;
  buildColours();
  render(state.settings);
  autoStartEl.disabled = !state.packaged;
  const count = displays.length;
  displaysEl.textContent = state.packaged
    ? `${count} display${count === 1 ? "" : "s"} detected.`
    : `${count} display${count === 1 ? "" : "s"} detected. "Start with Windows" needs a packaged build.`;
});
