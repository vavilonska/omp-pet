import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Measure natural card heights even when the list is constrained and scrollable.
// Measuring the clipped stack would make a tall window unable to grow again.
export function installActivityLayout(isDragging: () => boolean): void {
  const stack = document.querySelector<HTMLElement>("#bubble-stack")!;
  const background = document.querySelector<HTMLElement>("#background-bubbles")!;
  const group = document.querySelector<HTMLElement>("#background-group")!;
  const toggle = document.querySelector<HTMLElement>("#background-toggle")!;
  const main = document.querySelector<HTMLElement>("#bubble")!;
  let scheduled = false;
  let running = false;
  let dirty = false;

  async function update(): Promise<void> {
    scheduled = false;
    if (running) { dirty = true; return; }
    if (isDragging()) {
      scheduled = true;
      window.setTimeout(() => { void update(); }, 80);
      return;
    }
    running = true;
    dirty = false;
    try {
      const base = Number.parseFloat(getComputedStyle(stack).bottom) + 8;
      const cards = stack.hidden || background.hidden ? [] : [...background.children] as HTMLElement[];
      const gap = Number.parseFloat(getComputedStyle(background).rowGap) || 0;
      const naturalBackground = cards.reduce((sum, card) => sum + Number.parseFloat(getComputedStyle(card).height), 0)
        + Math.max(0, cards.length - 1) * gap;
      const toggleHeight = stack.hidden || group.hidden || toggle.hidden ? 0 : toggle.offsetHeight;
      const groupPadding = stack.hidden || group.hidden ? 0 : Number.parseFloat(getComputedStyle(group).paddingBottom) || 0;
      const groupGap = toggleHeight && cards.length ? Number.parseFloat(getComputedStyle(group).rowGap) || 0 : 0;
      const groupHeight = toggleHeight + groupPadding + groupGap + naturalBackground;
      const mainHeight = stack.hidden || main.hidden ? 0 : main.offsetHeight;
      const stackGap = mainHeight && groupHeight ? Number.parseFloat(getComputedStyle(stack).rowGap) || 0 : 0;
      await invoke("resize_activity_window", {
        height: Math.ceil(base + mainHeight + stackGap + groupHeight),
        minimumHeight: Math.ceil(base + mainHeight + stackGap + toggleHeight + groupPadding + groupGap + Math.min(80, naturalBackground)),
      });
    } catch (error) {
      console.error("Could not resize pet activity window", error);
    } finally {
      running = false;
      if (dirty) schedule();
    }
  }

  function schedule(): void {
    if (running) { dirty = true; return; }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { void update(); });
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(stack);
  resize.observe(main);
  void document.fonts.ready.then(schedule);
  document.fonts.addEventListener("loadingdone", schedule);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node instanceof HTMLElement) resize.unobserve(node);
      for (const node of record.addedNodes) if (node instanceof HTMLElement) resize.observe(node);
    }
    schedule();
  }).observe(stack, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["hidden", "class", "aria-expanded"],
  });
  for (const card of background.children) resize.observe(card);
  // Refit after a drag or a monitor/DPI change, even if content is unchanged.
  void getCurrentWindow().onMoved(schedule).catch(console.error);
  window.addEventListener("resize", schedule);
  schedule();
}
