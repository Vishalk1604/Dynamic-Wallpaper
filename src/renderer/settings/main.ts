/**
 * Settings window.
 *
 * Changes are applied live rather than on an OK button: the wallpaper is the preview, so a slider
 * that only takes effect when confirmed would make tuning it guesswork.
 */
import { SETTING_RANGES, type NumericSetting, type Settings } from "@shared/settings";
import { THEMES } from "@shared/themes";

type SettingsBridge = {
  read: () => Promise<{ settings: Settings; displays: number; packaged: boolean }>;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
  quit: () => void;
  close: () => void;
  onChanged: (callback: (settings: Settings) => void) => void;
};

const bridge = (globalThis as unknown as { settingsApi: SettingsBridge }).settingsApi;

const themesEl = document.getElementById("themes")!;
const slidersEl = document.getElementById("sliders")!;
const pausedEl = document.getElementById("paused") as HTMLInputElement;
const autoStartEl = document.getElementById("autoStart") as HTMLInputElement;
const displaysEl = document.getElementById("displays")!;

function rgbToCss(rgb: readonly [number, number, number]): string {
  const to255 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to255(rgb[0])}, ${to255(rgb[1])}, ${to255(rgb[2])})`;
}

function buildThemes(): void {
  for (const theme of THEMES) {
    const button = document.createElement("button");
    button.className = "theme";
    button.dataset["themeId"] = theme.id;
    button.title = theme.description;
    button.setAttribute("aria-pressed", "false");

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = theme.name;

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    // Only the first few, since that is how many a realistic monitor count will actually use.
    for (const colour of theme.colours.slice(0, 4)) {
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = rgbToCss(colour);
      swatches.appendChild(dot);
    }

    button.append(name, swatches);
    button.addEventListener("click", () => bridge.update({ themeId: theme.id }));
    themesEl.appendChild(button);
  }
}

const outputs = new Map<NumericSetting, HTMLOutputElement>();
const inputs = new Map<NumericSetting, HTMLInputElement>();

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
  }
}

function render(settings: Settings): void {
  for (const button of Array.from(themesEl.children) as HTMLElement[]) {
    button.setAttribute("aria-pressed", String(button.dataset["themeId"] === settings.themeId));
  }
  for (const [key, input] of inputs) {
    // Skip the control being dragged, so re-rendering cannot fight the user's own input.
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

void bridge.read().then(({ settings, displays, packaged }) => {
  render(settings);
  autoStartEl.disabled = !packaged;
  displaysEl.textContent = packaged
    ? `${displays} display${displays === 1 ? "" : "s"} detected. One blob per screen, connected by a stream.`
    : `${displays} display${displays === 1 ? "" : "s"} detected. "Start with Windows" needs a packaged build.`;
});
