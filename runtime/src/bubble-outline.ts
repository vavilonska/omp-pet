const SVG_NS = "http://www.w3.org/2000/svg";
export const OUTLINE_WIDTH = 1.5;

interface Box { left: number; top: number; width: number; height: number }

// Keep the complete stroke inside the element and align its outer bounds to
// device pixels. Fractional line heights must not blur an entire outline.
export function outlineGeometry(box: Box, radius: number, dpr: number) {
  const ceil = (value: number) => Math.ceil(value * dpr - 1e-7) / dpr;
  const floor = (value: number) => Math.floor(value * dpr + 1e-7) / dpr;
  const left = ceil(box.left) - box.left;
  const top = ceil(box.top) - box.top;
  const width = floor(box.left + box.width) - box.left - left;
  const height = floor(box.top + box.height) - box.top - top;
  return {
    x: left + OUTLINE_WIDTH / 2,
    y: top + OUTLINE_WIDTH / 2,
    width: Math.max(0, width - OUTLINE_WIDTH),
    height: Math.max(0, height - OUTLINE_WIDTH),
    rx: Math.max(0, Math.min(radius, width / 2, height / 2) - OUTLINE_WIDTH / 2),
  };
}

const outlines = new WeakMap<HTMLElement, { svg: SVGSVGElement; rect: SVGRectElement; key: string }>();

export function syncBubbleOutline(element: HTMLElement, bounds: DOMRect, style: CSSStyleDeclaration): void {
  let outline = outlines.get(element);
  if (!outline) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("bubble-outline");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "none");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke-width", String(OUTLINE_WIDTH));
    svg.append(rect);
    element.append(svg);
    outline = { svg, rect, key: "" };
    outlines.set(element, outline);
    element.classList.add("has-outline");
  }

  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
  // Enter animations scale the whole card. Use local geometry until settled,
  // then align against the final desktop pixel origin.
  const settled = Math.abs(bounds.width - width) < 0.01;
  const geometry = outlineGeometry({ left: settled ? bounds.left : 0,
    top: settled ? bounds.top : 0, width, height }, radius, window.devicePixelRatio);
  const viewBox = `0 0 ${width} ${height}`;
  const key = viewBox + JSON.stringify(geometry);
  if (key === outline.key) return;
  outline.svg.setAttribute("viewBox", viewBox);
  for (const [name, value] of Object.entries(geometry)) outline.rect.setAttribute(name, String(value));
  outline.key = key;
}
