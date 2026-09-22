import { invoke } from "@tauri-apps/api/core";
import { syncBubbleOutline } from "./bubble-outline";

export interface HitRect { left: number; top: number; right: number; bottom: number }
export interface HitRegion extends HitRect { radius?: number; clip?: HitRect }

export function clipRect(rect: HitRect, clip: HitRect): HitRect | null {
  const result = { left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top),
    right: Math.min(rect.right, clip.right), bottom: Math.min(rect.bottom, clip.bottom) };
  return result.right > result.left && result.bottom > result.top ? result : null;
}

// DOM rectangles are CSS pixels. Native window regions use physical pixels.
export function physicalRect(rect: HitRect, scale: number): HitRect {
  return {
    left: Math.floor(rect.left * scale), top: Math.floor(rect.top * scale),
    right: Math.ceil(rect.right * scale), bottom: Math.ceil(rect.bottom * scale),
  };
}

// Keep the full rounded outline, then clip it. Rounding the already-clipped
// rectangle would incorrectly round a card's straight edge during scrolling.
export function physicalRegion(rect: HitRect, scale: number, radius: number, clip: HitRect): HitRegion {
  return { ...physicalRect(rect, scale), radius: Math.max(0, Math.floor(radius * scale)),
    clip: physicalRect(clip, scale) };
}

export function installHitRegions(): void {
  let scheduled = false;
  let movingUntil = 0;
  let lastSent = "";

  async function update(): Promise<void> {
    const rects: HitRegion[] = [];
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const background = document.querySelector<HTMLElement>("#background-bubbles")!;
    const listRect = background.getBoundingClientRect();
    // Include the scrollbar and gaps only while this is a scrollable viewport.
    const scrollRect = background.scrollHeight > background.clientHeight
      ? clipRect(listRect, viewport) : null;
    if (scrollRect) rects.push(physicalRect(scrollRect, window.devicePixelRatio));
    for (const element of document.querySelectorAll<HTMLElement>("#pet, #empty, .activity-bubble, .background-stack-layer, #state, #pet-controls")) {
      if (element.hidden || element.getClientRects().length === 0) continue;
      const bounds = element.getBoundingClientRect();
      const stackPeek = element.closest<HTMLElement>(".background-stack-peek");
      const clip = stackPeek ? clipRect(stackPeek.getBoundingClientRect(), viewport)
        : element.classList.contains("background-bubble") ? clipRect(listRect, viewport) : viewport;
      const rect = clip && clipRect(bounds, clip);
      if (!rect) continue;
      const style = getComputedStyle(element);
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      if (element.matches(".activity-bubble, .background-stack-layer")) syncBubbleOutline(element, bounds, style);
      const animationScale = element.offsetWidth ? bounds.width / element.offsetWidth : 1;
      const region = physicalRegion(bounds, window.devicePixelRatio, radius * animationScale, clip!);
      rects.push(region);
      // Include the visible main bubble's small speech tail, but not stack gaps.
      if (element.id === "bubble") {
        const center = (rect.left + rect.right) / 2;
        const tail = physicalRect({ left: center - 7, right: center + 7,
          top: rect.bottom, bottom: rect.bottom + 8 }, window.devicePixelRatio);
        rects.push(tail);
      }
    }
    const fingerprint = JSON.stringify({ rects });
    if (fingerprint !== lastSent) {
      try {
        await invoke("set_hit_regions", { rects });
        lastSent = fingerprint;
      } catch (error) {
        console.error("Could not update pet window hit regions", error);
      }
    }
    scheduled = false;
    if (performance.now() < movingUntil) queueUpdate();
  }

  function schedule(): void {
    movingUntil = Math.max(movingUntil, performance.now() + 220);
    queueUpdate();
  }

  function queueUpdate(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { void update(); });
  }

  // Observe only layout-affecting mutations; timer text updates do not cause a
  // native call unless a visible rectangle actually changes.
  new MutationObserver(schedule).observe(document.querySelector("#app")!, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["hidden", "class", "style", "aria-expanded"],
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(document.querySelector("#bubble-stack")!);
  resize.observe(document.querySelector("#app")!);
  document.querySelector("#background-bubbles")!.addEventListener("pointerenter", schedule);
  document.querySelector("#background-bubbles")!.addEventListener("pointerleave", schedule);
  document.querySelector("#background-bubbles")!.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  // WebView zoom / monitor DPI changes can occur without a CSS-size change.
  function watchScale(): void {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
      schedule();
      watchScale();
    }, { once: true });
  }
  watchScale();
  schedule();
}
