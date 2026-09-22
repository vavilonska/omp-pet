import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import {
  animationFor,
  CELL_HEIGHT,
  CELL_WIDTH,
  normalizeCodexPet,
  type EffectivePetState,
  type NormalizedPet,
  type PetAnimationState,
  type PetManifest,
  type PetBubble,
} from "@omp-pet/core";
import "./style.css";
import { KeyedList } from "./keyed-list";
import { DragGesture, interactionState, lookDirection, playbackFrame } from "./interaction";
import { installHitRegions } from "./hit-region";
import { installActivityLayout } from "./activity-layout";

interface PetInfo extends PetManifest {
  selected: boolean;
  revision: number;
}

interface RuntimeSnapshot {
  state: EffectivePetState;
  selectedPet: PetInfo | null;
  spriteUrl: string | null;
  debugEnabled: boolean;
}

const canvas = document.querySelector<HTMLCanvasElement>("#pet")!;
const context = canvas.getContext("2d", { alpha: true })!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const stateOutput = document.querySelector<HTMLOutputElement>("#state")!;
const bubble = document.querySelector<HTMLElement>("#bubble")!;
const bubbleTitle = document.querySelector<HTMLElement>("#bubble-title")!;
const bubbleStatus = document.querySelector<HTMLElement>("#bubble-status")!;
const bubbleDetail = document.querySelector<HTMLElement>("#bubble-detail")!;
const bubbleElapsed = document.querySelector<HTMLTimeElement>("#bubble-elapsed")!;
const backgroundBubbles = document.querySelector<HTMLElement>("#background-bubbles")!;
const backgroundGroup = document.querySelector<HTMLElement>("#background-group")!;
const backgroundToggle = document.querySelector<HTMLElement>("#background-toggle")!;
const backgroundCount = document.querySelector<HTMLElement>("#background-count")!;
let backgroundExpanded = false;

let snapshot: RuntimeSnapshot | null = null;
let normalizedPet: NormalizedPet | null = null;
let spritesheet: HTMLImageElement | null = null;
let animationKey = "";
let animationStartedAt = performance.now();
let hovered = false;
let greetingUntil = performance.now() + 2_100;
let drag: { id: number; gesture: DragGesture; origin: Promise<PhysicalPosition>; scale: number } | null = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const petWindow = getCurrentWindow();
let activityVisible = true;
let loadGeneration = 0;
let timer: number | null = null;
let pointerDirection: number | null = null;
let elapsedTimer: number | null = null;
let currentBubble: PetBubble | null = null;
let currentBackgroundBubbles: PetBubble[] = [];
const backgroundRows = new KeyedList<PetBubble, HTMLElement>({
  create: createBackgroundBubble,
  append: card => backgroundBubbles.append(card),
  remove: card => card.remove(),
  update: (card, item, index) => {
    card.dataset.index = String(index);
    card.dataset.kind = item.kind;
    const title = card.querySelector("strong")!;
    const detail = card.querySelector("p")!;
    if (title.textContent !== item.title) title.textContent = item.title;
    if (detail.textContent !== (item.detail ?? "")) detail.textContent = item.detail ?? "";
    detail.hidden = !item.detail;
    card.setAttribute("aria-label", `${item.title}，点击${card.getAttribute("aria-expanded") === "true" ? "收起" : "展开"}`);
  },
});

function clearTimer(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function updateElapsedElement(element: HTMLTimeElement, item: PetBubble | null): void {
  const startedAt = item?.startedAt;
  const shouldShow = Boolean(startedAt && item?.expiresAt === null);
  element.hidden = !shouldShow;
  if (shouldShow && startedAt) {
    element.textContent = formatElapsed(startedAt);
    element.dateTime = `PT${Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))}S`;
  }
}

function updateElapsed(): void {
  updateElapsedElement(bubbleElapsed, currentBubble);
  for (const [index, item] of currentBackgroundBubbles.entries()) {
    const element = backgroundBubbles.querySelector<HTMLTimeElement>(`[data-index="${index}"] time`);
    if (element) updateElapsedElement(element, item);
  }
}

function ensureElapsedTimer(): void {
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  const hasActiveTimer = [currentBubble, ...currentBackgroundBubbles].some(
    item => item?.startedAt && item.expiresAt === null,
  );
  updateElapsed();
  if (hasActiveTimer) elapsedTimer = window.setInterval(updateElapsed, 1_000);
}

function renderBubble(next: PetBubble | null): void {
  const entering = bubble.hidden;
  const changed = currentBubble?.id !== next?.id;
  if (next?.expiresAt === null) { activityVisible = true; }
  document.querySelector<HTMLElement>("#bubble-stack")!.hidden = !activityVisible;
  if (changed) { activityVisible = true; document.querySelector<HTMLElement>("#bubble-stack")!.hidden = false; }
  currentBubble = next;
  if (!next) {
    bubble.hidden = true;
    ensureElapsedTimer();
    return;
  }

  bubbleTitle.textContent = next.title;
  bubbleDetail.textContent = next.detail ?? "";
  bubbleDetail.hidden = !next.detail;
  bubble.dataset.kind = next.kind;
  const statusLabels: Record<string, string> = { completed: "已完成", success: "已完成", error: "执行出错", approval: "等待确认", retry: "正在重试" };
  bubbleStatus.textContent = statusLabels[next.kind] ?? "进行中";
  bubble.setAttribute("role", next.kind === "completed" ? "button" : "status");
  bubble.tabIndex = next.kind === "completed" ? 0 : -1;
  bubble.setAttribute("aria-label", next.kind === "completed" ? "已完成，点击返回 OMP 并关闭提示" : next.title);
  bubble.dataset.background = String(next.background);
  bubble.hidden = false;
  if (entering) {
    bubble.classList.remove("bubble-enter");
    void bubble.offsetWidth;
    bubble.classList.add("bubble-enter");
  }
  ensureElapsedTimer();
}

function createBackgroundBubble(item: PetBubble): HTMLElement {
  const card = document.createElement("section");
  card.className = "activity-bubble background-bubble bubble-enter";
  card.dataset.kind = item.kind;
  card.dataset.background = "true";
  card.setAttribute("role", "button");
  card.setAttribute("aria-expanded", "false");
  card.tabIndex = 0;

  const header = document.createElement("header");
  const dot = document.createElement("span");
  dot.className = "bubble-dot";
  dot.setAttribute("aria-hidden", "true");
  const title = document.createElement("strong");
  title.textContent = item.title;
  const elapsed = document.createElement("time");
  const chevron = document.createElement("span");
  chevron.className = "bubble-chevron";
  chevron.setAttribute("aria-hidden", "true");
  header.append(dot, title, elapsed, chevron);
  card.append(header);

  const detail = document.createElement("p");
  detail.textContent = item.detail ?? "";
  detail.hidden = !item.detail;
  card.append(detail);
  function toggle(): void {
    const expanded = card.getAttribute("aria-expanded") !== "true";
    card.setAttribute("aria-expanded", String(expanded));
    card.setAttribute("aria-label", `${title.textContent}，点击${expanded ? "收起" : "展开"}`);
  }
  card.addEventListener("click", toggle);
  card.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) toggle();
    }
  });
  return card;
}

function renderBackgroundBubbles(next: PetBubble[]): void {
  currentBackgroundBubbles = backgroundRows.render(next);
  renderBackgroundGroup();
  if (next.length) { activityVisible = true; document.querySelector<HTMLElement>("#bubble-stack")!.hidden = false; }
  ensureElapsedTimer();
}

function renderBackgroundGroup(): void {
  const count = currentBackgroundBubbles.length;
  const grouped = count > 1;
  const collapsed = grouped && !backgroundExpanded;
  backgroundGroup.hidden = count === 0;
  backgroundGroup.classList.toggle("is-collapsed", collapsed);
  backgroundToggle.hidden = !grouped;
  backgroundBubbles.hidden = collapsed;
  backgroundCount.textContent = String(count);
  backgroundToggle.setAttribute("aria-expanded", String(!collapsed));
  backgroundToggle.setAttribute("aria-label", `${count} 个子代理，点击${collapsed ? "展开列表" : "堆叠收起"}`);
}

function toggleBackgroundGroup(): void {
  backgroundExpanded = !backgroundExpanded;
  renderBackgroundGroup();
}
backgroundToggle.addEventListener("click", toggleBackgroundGroup);
backgroundToggle.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (!event.repeat) toggleBackgroundGroup();
  }
});

function renderDebug(state: EffectivePetState, enabled: boolean): void {
  stateOutput.value = `${state.animation} · ${state.reason}`;
  stateOutput.hidden = !enabled;
}

function render(): void {
  clearTimer();
  if (document.hidden || !spritesheet || !normalizedPet) return;
  const now = performance.now();
  const base = snapshot?.state.animation ?? "idle";
  const state = interactionState(base, hovered, drag?.gesture.direction ?? null, now < greetingUntil);
  if (state !== animationKey) { animationKey = state; animationStartedAt = now; }
  const look = !drag && ["idle", "running", "waving"].includes(state) && pointerDirection !== null
    && normalizedPet.lookDirections.length > 0;
  const frame = playbackFrame(state, now - animationStartedAt, reducedMotion.matches);
  let { row, column } = frame;
  if (look) {
    const direction = animationFor(normalizedPet, "look", pointerDirection!);
    if (!("frames" in direction)) { row = direction.row; column = direction.column; }
  }
  context.clearRect(0, 0, CELL_WIDTH, CELL_HEIGHT);
  context.drawImage(spritesheet, column * CELL_WIDTH, row * CELL_HEIGHT,
    CELL_WIDTH, CELL_HEIGHT, 0, 0, CELL_WIDTH, CELL_HEIGHT);
  const delay = !look ? frame.delay : null;
  const greetingDelay = greetingUntil > now ? greetingUntil - now : null;
  const nextDelay = delay === null ? greetingDelay : greetingDelay === null ? delay : Math.min(delay, greetingDelay);
  if (nextDelay !== null) timer = window.setTimeout(render, Math.max(1, nextDelay));
}

async function loadSelectedPet(next: RuntimeSnapshot): Promise<void> {
  const generation = ++loadGeneration;
  snapshot = next;
  renderDebug(next.state, next.debugEnabled);
  renderBubble(next.state.bubble);
  renderBackgroundBubbles(next.state.backgroundBubbles ?? []);
  clearTimer();
  animationKey = "";
  spritesheet = null;
  normalizedPet = null;

  if (!next.selectedPet || !next.spriteUrl) {
    context.clearRect(0, 0, CELL_WIDTH, CELL_HEIGHT);
    canvas.hidden = true;
    empty.hidden = false;
    return;
  }

  const pet = next.selectedPet;
  normalizedPet = normalizeCodexPet({
    id: pet.id,
    displayName: pet.displayName,
    description: pet.description,
    spriteVersionNumber: pet.spriteVersionNumber,
    spritesheetPath: pet.spritesheetPath,
  });

  const image = new Image();
  image.decoding = "async";
  image.src = next.spriteUrl;
  await image.decode();
  if (generation !== loadGeneration) return;
  spritesheet = image;
  greetingUntil = performance.now() + 2_100;
  canvas.hidden = false;
  empty.hidden = true;
  render();
}

const activityStack = document.querySelector<HTMLElement>("#bubble-stack")!;
const controls = document.createElement("nav");
controls.id = "pet-controls";
controls.hidden = true;
controls.setAttribute("aria-label", "宠物菜单");
document.querySelector("#app")!.append(controls);

function reportError(error: unknown): void {
  console.error(error);
  stateOutput.hidden = false;
  stateOutput.value = `操作失败：${String(error)}`;
}
let activatingCompletion = false;
async function focusCompletedBubble(): Promise<void> {
  const selected = currentBubble;
  if (selected?.kind !== "completed" || activatingCompletion) return;
  activatingCompletion = true;
  try {
    const warning = await invoke<string | null>("focus_omp", { bubbleId: selected.id });
    if (currentBubble?.id === selected.id) renderBubble(null);
    if (warning) console.warn("Completed bubble dismissed; OMP focus failed:", warning);
  } catch (error) {
    if (currentBubble?.id === selected.id) {
      bubbleDetail.hidden = false;
      bubbleDetail.textContent = String(error);
    }
  } finally {
    activatingCompletion = false;
  }
}
bubble.addEventListener("click", () => { void focusCompletedBubble(); });
bubble.addEventListener("keydown", event => {
  if (currentBubble?.kind === "completed" && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    void focusCompletedBubble();
  }
});
async function control(request: Record<string, unknown>): Promise<void> {
  await invoke("pet_control", { request });
}
function button(parent: HTMLElement, label: string, action: () => void | Promise<void>): void {
  const item = document.createElement("button");
  item.type = "button";
  item.textContent = label;
  item.addEventListener("click", () => { Promise.resolve().then(action).catch(reportError); });
  parent.append(item);
}
function toggleActivity(): void {
  const active = currentBubble?.expiresAt === null || currentBackgroundBubbles.length > 0;
  activityVisible = active || !activityVisible;
  renderBubble(currentBubble);
  activityStack.hidden = !activityVisible;
}
button(controls, "显示 / 收起任务", toggleActivity);
button(controls, "上一只", () => control({ action: "previous" }));
button(controls, "下一只", () => control({ action: "next" }));
button(controls, "挥手", () => control({ action: "play", animation: "waving" }));
button(controls, "跳跃", () => control({ action: "play", animation: "jumping" }));
button(controls, "隐藏宠物", () => control({ action: "hide" }));
button(controls, "关闭菜单", () => { controls.hidden = true; });
canvas.tabIndex = 0;
canvas.setAttribute("role", "button");
canvas.setAttribute("aria-label", "宠物：单击显示或收起任务，右键打开菜单");
canvas.addEventListener("contextmenu", event => { event.preventDefault(); controls.hidden = !controls.hidden; });
canvas.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleActivity(); }
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault(); controls.hidden = !controls.hidden;
  }
});
document.addEventListener("keydown", event => { if (event.key === "Escape") controls.hidden = true; });
canvas.addEventListener("pointerenter", () => { hovered = true; render(); });
canvas.addEventListener("pointerleave", () => { hovered = false; render(); });
let pendingPosition: PhysicalPosition | null = null;
let moving = false;
async function moveWindow(position: PhysicalPosition): Promise<void> {
  pendingPosition = position;
  if (moving) return;
  moving = true;
  try {
    while (pendingPosition) {
      const next = pendingPosition; pendingPosition = null;
      await petWindow.setPosition(next);
    }
  } finally { moving = false; }
}
async function updateDrag(event: PointerEvent): Promise<void> {
  const active = drag;
  if (!active || active.id !== event.pointerId || !active.gesture.update(event.screenX, event.screenY)) return;
  const dx = (event.screenX - active.gesture.x) * active.scale;
  const dy = (event.screenY - active.gesture.y) * active.scale;
  render();
  const origin = await active.origin;
  await moveWindow(new PhysicalPosition(Math.round(origin.x + dx), Math.round(origin.y + dy)));
}
canvas.addEventListener("pointerdown", event => {
  if (event.button !== 0 || event.ctrlKey || drag) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, gesture: new DragGesture(event.screenX, event.screenY),
    origin: petWindow.outerPosition(), scale: window.devicePixelRatio };
  void drag.origin.catch(reportError);
});
canvas.addEventListener("pointermove", event => { void updateDrag(event).catch(reportError); });
canvas.addEventListener("pointerup", event => {
  const active = drag;
  if (!active || active.id !== event.pointerId) return;
  void updateDrag(event).catch(reportError);
  drag = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (!active.gesture.moved) toggleActivity();
  render();
});
for (const name of ["pointercancel", "lostpointercapture"] as const) {
  canvas.addEventListener(name, () => { drag = null; hovered = canvas.matches(":hover"); render(); });
}
reducedMotion.addEventListener("change", render);
// Tauri supplies screen coordinates without stealing clicks from other windows.
async function trackCursor(): Promise<void> {
  try {
    if (!document.hidden && !drag) {
      const [cursor, origin] = await Promise.all([cursorPosition(), petWindow.outerPosition()]);
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio;
      const next = lookDirection((cursor.x - origin.x) / scale - rect.left - rect.width / 2,
        (cursor.y - origin.y) / scale - rect.top - rect.height / 2);
      if (next !== pointerDirection) { pointerDirection = next; render(); }
    }
  } catch (error) { console.error("Pet cursor tracking failed", error); }
  window.setTimeout(() => { void trackCursor(); }, document.hidden ? 500 : 80);
}
void trackCursor();
await listen("pet://shown", () => { greetingUntil = performance.now() + 2_100; animationKey = ""; render(); });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimer();
  else render();
});

await listen<EffectivePetState>("pet://state", event => {
  if (!snapshot) return;
  snapshot = { ...snapshot, state: event.payload };
  renderDebug(event.payload, snapshot.debugEnabled);
  renderBubble(event.payload.bubble);
  renderBackgroundBubbles(event.payload.backgroundBubbles ?? []);
  activityStack.hidden = !activityVisible;
  render();
});

await listen<RuntimeSnapshot>("pet://selected", event => {
  void loadSelectedPet(event.payload);
});

await listen<boolean>("pet://debug", event => {
  if (!snapshot) return;
  snapshot = { ...snapshot, debugEnabled: event.payload };
  renderDebug(snapshot.state, event.payload);
});

const initial = await invoke<RuntimeSnapshot>("get_snapshot");
await loadSelectedPet(initial);
installActivityLayout(() => drag !== null || moving);
installHitRegions();
