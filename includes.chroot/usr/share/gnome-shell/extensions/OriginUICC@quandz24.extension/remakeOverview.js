import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Background from "resource:///org/gnome/shell/ui/background.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

const OVERVIEW_BACKGROUND_BLUR_EFFECT = "originuicc-overview-background-blur";
const OVERVIEW_BACKGROUND_BLUR_RADIUS = 90;
const OVERVIEW_BACKGROUND_BLUR_BRIGHTNESS = 0.8;

const APP_LIBRARY_TAB_ALL = 0;
const APP_LIBRARY_TAB_ARRANGED = 1;
const ARRANGED_FOLDERS_PER_PAGE = 8;
const ARRANGED_REBUILD_DELAY = 250;
const APP_LIBRARY_SWITCH_WIDTH = 288;
const APP_LIBRARY_SWITCH_HEIGHT = 45;
const APP_LIBRARY_SWITCH_PADDING = 5;
const APP_LIBRARY_SWITCH_TAB_WIDTH =
  (APP_LIBRARY_SWITCH_WIDTH - APP_LIBRARY_SWITCH_PADDING * 2) / 2;
const APP_LIBRARY_SWITCH_TAB_HEIGHT =
  APP_LIBRARY_SWITCH_HEIGHT - APP_LIBRARY_SWITCH_PADDING * 2;
const ARRANGED_PAGE_ANIMATION_TIME = 260;
const ARRANGED_SIDE_PAGE_OPACITY = 69;
const ARRANGED_SIDE_PAGE_SCALE = 0.8;
const ARRANGED_SIDE_PAGE_OFFSET_RATIO = 0.58;
const FOLDER_OPEN_ANIMATION_TIME = 490;
const FOLDER_OPEN_ANIMATION_TIME_OPACITY_CLONE_BACKGROUND = 120;
const FOLDER_CLOSE_ANIMATION_TIME = 350;
const FOLDER_OPEN_GRID_SCALE = 0.8;
const FOLDER_OPEN_GRID_OPACITY = 0;
const FOLDER_OPEN_ICON_DELAY = 10;
const FOLDER_OPEN_VISIBLE_ICON_COUNT = 7;
const FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS = 20;
const CLOSED_FOLDER_PREVIEW_PADDING = 15;
const CLOSED_FOLDER_PREVIEW_SIZE = 112 + CLOSED_FOLDER_PREVIEW_PADDING * 2;
const CLOSED_FOLDER_PREVIEW_RADIUS = 30;
const CLOSED_FOLDER_CELL_SIZE = 52;
const CLOSED_FOLDER_CELL_SPACING = 8;
const ARRANGED_NAV_BUTTON_SIZE = 52;
const ARRANGED_NAV_SIDE_MARGIN = 120;
const ARRANGED_PAGE_INDICATOR_DOT_SIZE = 7;
const ARRANGED_PAGE_INDICATOR_DOT_SPACING = 9;
const ARRANGED_PAGE_INDICATOR_BOTTOM = 10;
const OPEN_FOLDER_ICON_SIZE = 95;
const OPEN_FOLDER_ICON_TEXTURE_SIZE = 80;
const ICON_HOVER_IN_TIME = 90;
const ICON_HOVER_OUT_TIME = 280;
const FRAME_INTERVAL = 1000 / 60;
const PROGRESSED_CUBIC_STEP_MS = FRAME_INTERVAL;
const PROGRESSED_CUBIC_MIN_STEPS = 240;
const ORIGIN_DEFAULT_CUBIC = ["cubic", 0.25, 0.1, 0.25, 1];
const ORIGIN_BOUNCE_CUBIC = ["cubic", 0.25, 1.2, 0.39, 1];
const FOLDER_OPEN_CUBIC = ["cubic", 0.25, 1.2, 0.39, 1];
const FOLDER_CLOSE_CUBIC = ["cubic", 0.25, 0.1, 0.25, 1];
const APP_GRID_ANIMATION_START_SCALE = 1.9;
const APP_GRID_ANIMATION_DURATION = 900;
const APP_GRID_ANIMATION_DELAY_RATIO = 120;
const APP_GRID_ANIMATION_BEZIER = [
  "linear",
  0,
  [0.002, 0.001],
  [0.005, 0.007],
  [0.01, 0.025],
  [0.016, 0.06],
  [0.022, 0.106],
  [0.033, 0.208],
  [0.071, 0.601],
  [0.085, 0.722],
  [0.098, 0.815],
  [0.112, 0.894],
  [0.127, 0.955],
  [0.135, 0.98],
  [0.143, 0.999],
  [0.152, 1.015],
  [0.161, 1.026],
  [0.169, 1.033],
  [0.177, 1.037],
  [0.186, 1.039],
  [0.197, 1.039],
  [0.215, 1.034],
  [0.261, 1.016],
  [0.288, 1.007],
  [0.319, 1.002],
  1,
];
const APP_GRID_ANIMATION_FRAME_INTERVAL = Math.round(FRAME_INTERVAL);
const TAB_SWITCH_ANIMATION_DURATION = 350;
const TAB_SWITCH_ANIMATION_DELAY_RATIO = 290;
const TAB_SWITCH_HIDE_CUBIC = ["cubic", 0.36, 0.66, 0.07, 0.97];
const TAB_SWITCH_SHOW_CUBIC = ["cubic", 0.25, 1.4, 0.39, 1];

const _progressedEasingCache = new Map();

function _cubicCoord(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

function _normalizeEasingSpec(easing) {
  if (!Array.isArray(easing)) return ORIGIN_DEFAULT_CUBIC;

  if (typeof easing[0] === "string") return easing;

  if (easing.length === 4) return ["cubic", ...easing];

  return ORIGIN_DEFAULT_CUBIC;
}

function _progressedEasingKey(easing, duration) {
  return `${Math.ceil(duration / PROGRESSED_CUBIC_STEP_MS)}:${JSON.stringify(
    _normalizeEasingSpec(easing),
  )}`;
}

function _createProgressedCubic(easing, duration) {
  const maxIndex = Math.max(1, Math.ceil(duration / PROGRESSED_CUBIC_STEP_MS));
  const table = new Float32Array(maxIndex + 1);
  const [, x1, y1, x2, y2] = _normalizeEasingSpec(easing);
  const steps = Math.max(PROGRESSED_CUBIC_MIN_STEPS, maxIndex * 8);
  let lastIndex = 0;
  let lastY = 0;

  table[0] = 0;

  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const x = _cubicCoord(x1, x2, t);
    const y = _cubicCoord(y1, y2, t);
    const index = Math.round(Math.clamp(x, 0, 1) * maxIndex);

    if (index > lastIndex) {
      const span = index - lastIndex;

      for (let i = 1; i <= span; i++)
        table[lastIndex + i] = lastY + (y - lastY) * (i / span);

      lastIndex = index;
    }

    lastY = y;
  }

  if (lastIndex < maxIndex) {
    const span = maxIndex - lastIndex;

    for (let i = 1; i <= span; i++)
      table[lastIndex + i] = lastY + (1 - lastY) * (i / span);
  }

  table[maxIndex] = 1;
  return table;
}

function _isNonDecreasing(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
  }

  return true;
}

function _valuesLookLikeOffsets(values) {
  return (
    values.length > 0 &&
    values.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    _isNonDecreasing(values)
  );
}

function _guessLinearStopOrder(rawStops) {
  const pairs = rawStops
    .filter((stop) => Array.isArray(stop) && stop.length >= 2)
    .map((stop) => [Number(stop[0]), Number(stop[1])])
    .filter(
      ([first, second]) => Number.isFinite(first) && Number.isFinite(second),
    );

  if (pairs.length < 2) return "value-offset";

  const firstValues = pairs.map(([first]) => first);
  const secondValues = pairs.map(([, second]) => second);
  const firstLooksLikeOffsets = _valuesLookLikeOffsets(firstValues);
  const secondLooksLikeOffsets = _valuesLookLikeOffsets(secondValues);
  const firstHasOvershoot = firstValues.some((value) => value < 0 || value > 1);
  const secondHasOvershoot = secondValues.some(
    (value) => value < 0 || value > 1,
  );

  if (
    firstLooksLikeOffsets &&
    !firstHasOvershoot &&
    (!secondLooksLikeOffsets || secondHasOvershoot)
  )
    return "offset-value";

  return "value-offset";
}

function _linearStopValue(stop, order) {
  if (!Array.isArray(stop)) return Number(stop);

  return Number(order === "offset-value" ? stop[1] : stop[0]);
}

function _linearStopOffset(stop, order) {
  if (!Array.isArray(stop) || stop.length < 2) return null;

  const offset = Number(order === "offset-value" ? stop[0] : stop[1]);
  return Number.isFinite(offset) ? offset : null;
}

function _normalizeLinearStops(easing) {
  const rawStops = _normalizeEasingSpec(easing).slice(1);
  const order = _guessLinearStopOrder(rawStops);
  const stops = rawStops
    .map((stop) => ({
      value: _linearStopValue(stop, order),
      offset: _linearStopOffset(stop, order),
    }))
    .filter(({ value }) => Number.isFinite(value));

  if (!stops.length)
    return [
      { value: 0, offset: 0 },
      { value: 1, offset: 1 },
    ];
  if (stops.length === 1)
    return [
      { value: stops[0].value, offset: 0 },
      { value: stops[0].value, offset: 1 },
    ];

  stops[0].offset ??= 0;
  stops[stops.length - 1].offset ??= 1;

  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].offset !== null) continue;

    const start = i - 1;
    let end = i + 1;

    while (end < stops.length && stops[end].offset === null) end++;

    const startOffset = stops[start].offset ?? 0;
    const endOffset = stops[end]?.offset ?? 1;
    const span = end - start;

    for (let j = i; j < end; j++)
      stops[j].offset =
        startOffset + ((endOffset - startOffset) * (j - start)) / span;

    i = end - 1;
  }

  let lastOffset = 0;

  for (const stop of stops) {
    stop.offset = Math.max(stop.offset ?? lastOffset, lastOffset);
    lastOffset = stop.offset;
  }

  return stops;
}

function _createProgressedLinear(easing, duration) {
  const maxIndex = Math.max(1, Math.ceil(duration / PROGRESSED_CUBIC_STEP_MS));
  const table = new Float32Array(maxIndex + 1);
  const stops = _normalizeLinearStops(easing);
  let stopIndex = 0;

  for (let i = 0; i <= maxIndex; i++) {
    const progress = i / maxIndex;

    while (
      stopIndex < stops.length - 2 &&
      progress > stops[stopIndex + 1].offset
    )
      stopIndex++;

    const from = stops[stopIndex];
    const to = stops[Math.min(stopIndex + 1, stops.length - 1)];
    const span = Math.max(to.offset - from.offset, Number.EPSILON);
    const localProgress = Math.clamp((progress - from.offset) / span, 0, 1);

    table[i] = from.value + (to.value - from.value) * localProgress;
  }

  return table;
}

function _createProgressedEasing(easing, duration) {
  const spec = _normalizeEasingSpec(easing);

  if (spec[0] === "linear") return _createProgressedLinear(spec, duration);

  return _createProgressedCubic(spec, duration);
}

function _getProgressedCubic(cubic, duration) {
  const key = _progressedEasingKey(cubic, duration);
  let table = _progressedEasingCache.get(key);

  if (!table) {
    table = _createProgressedEasing(cubic, duration);
    _progressedEasingCache.set(key, table);
  }

  return table;
}

function _progressFromCubicTable(table, elapsedMs) {
  const index = Math.round(elapsedMs / PROGRESSED_CUBIC_STEP_MS);

  if (index <= 0) return table[0];
  if (index >= table.length) return table[table.length - 1];
  return table[index];
}

function _cancelActorEase(actor) {
  if (!actor?._originuiccEaseIds) return;

  for (const id of actor._originuiccEaseIds) {
    try {
      GLib.source_remove(id);
    } catch (_) {}
  }

  actor._originuiccEaseIds.clear();
}

function _setActorProperty(actor, property, value) {
  try {
    if (!actor || actor.is_destroyed?.()) return false;
    actor[property] = value;
    return true;
  } catch (_) {
    return false;
  }
}

function _easeActor(actor, properties, params = {}) {
  if (!actor || actor.is_destroyed?.()) return 0;

  const duration = params.duration ?? 0;
  const delay = params.delay ?? 0;
  const cubic = params.cubic ?? ORIGIN_DEFAULT_CUBIC;
  const onComplete = params.onComplete ?? null;

  if (params.cancel !== false) _cancelActorEase(actor);

  const start = () => {
    try {
      if (actor.is_destroyed?.()) return GLib.SOURCE_REMOVE;
    } catch (_) {
      return GLib.SOURCE_REMOVE;
    }

    if (duration <= 0) {
      for (const [property, value] of Object.entries(properties))
        _setActorProperty(actor, property, value);

      onComplete?.();
      return GLib.SOURCE_REMOVE;
    }

    const starts = new Map();

    for (const property of Object.keys(properties)) {
      try {
        starts.set(property, actor[property] ?? 0);
      } catch (_) {
        return GLib.SOURCE_REMOVE;
      }
    }

    const table = _getProgressedCubic(cubic, duration);
    const startTime = GLib.get_monotonic_time();
    let frameId = 0;

    frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_INTERVAL, () => {
      try {
        if (actor.is_destroyed?.()) {
          actor._originuiccEaseIds?.delete(frameId);
          return GLib.SOURCE_REMOVE;
        }
      } catch (_) {
        return GLib.SOURCE_REMOVE;
      }

      const elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
      const eased = _progressFromCubicTable(table, elapsed);
      const inv = 1 - eased;

      for (const [property, toValue] of Object.entries(properties)) {
        const fromValue = starts.get(property) ?? 0;
        _setActorProperty(actor, property, fromValue * inv + toValue * eased);
      }

      if (elapsed < duration) return GLib.SOURCE_CONTINUE;

      for (const [property, value] of Object.entries(properties))
        _setActorProperty(actor, property, value);

      onComplete?.();
      actor._originuiccEaseIds?.delete(frameId);
      return GLib.SOURCE_REMOVE;
    });

    actor._originuiccEaseIds ??= new Set();
    actor._originuiccEaseIds.add(frameId);
    return GLib.SOURCE_REMOVE;
  };

  if (delay <= 0) return start();

  let delayId = 0;
  delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    actor._originuiccEaseIds?.delete(delayId);
    return start();
  });

  actor._originuiccEaseIds ??= new Set();
  actor._originuiccEaseIds.add(delayId);
  return delayId;
}

const ARRANGED_FOLDER_RULES = [
  {
    key: "utilities",
    title: "Utilities",
    categories: ["Utility", "Settings"],
    idParts: ["settings", "tweaks", "terminal", "console", "calculator"],
  },
  {
    key: "communication",
    title: "Communication",
    categories: [
      "Network",
      "Email",
      "Chat",
      "InstantMessaging",
      "Telephony",
      "ContactManagement",
    ],
    idParts: ["mail", "chat", "message", "telegram", "discord", "whatsapp"],
  },
  {
    key: "productivity",
    title: "Productivity",
    categories: ["Calendar", "Clock", "TextEditor", "ProjectManagement"],
    idParts: ["calendar", "todo", "notes", "agenda", "planner"],
  },
  {
    key: "home-arcade",
    title: "Home & Arcade",
    categories: ["Game", "KidsGame", "ArcadeGame", "Amusement"],
    idParts: ["game", "steam", "lutris", "heroic"],
  },
  {
    key: "suggested",
    title: "Suggested",
    categories: ["AudioVideo", "Audio", "Video", "Player", "Music"],
    idParts: ["music", "video", "player", "photos", "camera"],
  },
  {
    key: "information-banking",
    title: "Information & Banking",
    categories: ["Finance", "News", "Education", "Science"],
    idParts: ["bank", "finance", "news", "reader", "books"],
  },
  {
    key: "office",
    title: "Office",
    categories: ["Office", "Spreadsheet", "WordProcessor", "Presentation"],
    idParts: ["office", "writer", "calc", "impress", "document"],
  },
  {
    key: "graphics",
    title: "Graphics",
    categories: ["Graphics", "Photography", "2DGraphics", "RasterGraphics"],
    idParts: ["image", "photo", "draw", "gimp", "inkscape"],
  },
  {
    key: "development",
    title: "Development",
    categories: ["Development", "IDE", "GUIDesigner"],
    idParts: ["code", "studio", "builder", "git", "developer"],
  },
  {
    key: "system",
    title: "System",
    categories: ["System", "Monitor", "Security"],
    idParts: ["system", "monitor", "disk", "logs"],
  },
];

function _getAppCategories(appInfo) {
  try {
    const categories = appInfo.get_categories();
    return categories ? categories.split(";").filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function _appMatchesRule(appInfo, rule) {
  const categories = _getAppCategories(appInfo);
  const id = appInfo.get_id()?.toLowerCase?.() ?? "";
  const name = appInfo.get_display_name?.()?.toLowerCase?.() ?? "";

  if (categories.some((category) => rule.categories.includes(category)))
    return true;

  return rule.idParts.some((part) => id.includes(part) || name.includes(part));
}

function _createIconTexture(app, size) {
  try {
    return app.create_icon_texture(size);
  } catch (_) {
    return new St.Icon({
      icon_name: "application-x-executable-symbolic",
      icon_size: size,
    });
  }
}

class OriginAppGridAnimator {
  constructor(shouldAnimate = null) {
    this._opened = false;
    this._animating = false;
    this._timeoutIds = new Set();
    this._signalIds = [];
    this._clipStates = new Map();
    this._fitMode = null;
    this._shouldAnimate = shouldAnimate;
  }

  enable() {
    this._fitMode =
      Main.overview?._overview?.controls?._workspacesDisplay
        ?._fitModeAdjustment ?? null;

    if (this._fitMode) {
      this._signalIds.push([
        this._fitMode,
        this._fitMode.connect("notify::value", () => this._sync()),
      ]);
    }

    if (Main.overview) {
      this._signalIds.push([
        Main.overview,
        Main.overview.connect("showing", () => {
          if (this._canAnimate()) this._hideIcons();
          else this.cancel(true);
        }),
      ]);
      this._signalIds.push([
        Main.overview,
        Main.overview.connect("hiding", () => {
          if (this._canAnimate()) this._animateClose();
          else this.cancel(true);
        }),
      ]);
      this._signalIds.push([
        Main.overview,
        Main.overview.connect("hidden", () => {
          this._opened = false;
          if (this._canAnimate()) this._hideIcons();
          else this.cancel(true);
        }),
      ]);
    }

    this._disableGridClipping();
    this._hideIcons();
  }

  disable() {
    this._clearTimeouts();

    for (const [object, signalId] of this._signalIds) {
      try {
        object.disconnect(signalId);
      } catch (_) {}
    }

    this._signalIds = [];
    this._fitMode = null;
    this._restoreIcons();
    this._restoreGridClipping();
  }

  cancel(restoreIcons = false) {
    this._clearTimeouts();
    this._animating = false;
    if (restoreIcons) this._restoreIcons();
  }

  _canAnimate() {
    try {
      return this._shouldAnimate?.() ?? true;
    } catch (_) {
      return true;
    }
  }

  _sync() {
    const progress = this._fitMode?.value ?? 0;

    if (!this._canAnimate()) {
      this.cancel(true);
      this._opened = progress > 0;
      return;
    }

    if (progress > 0 && !this._opened) {
      this._opened = true;
      this._animateOpenQueued();
    } else if (progress <= 0 && this._opened) {
      this._opened = false;
      this._hideIcons();
    }
  }

  _animateOpenQueued() {
    if (!this._canAnimate()) {
      this.cancel(true);
      return;
    }

    this._hideIcons();

    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      this._removeTimeout(id);
      this._animateOpen();
      return GLib.SOURCE_REMOVE;
    });
    this._timeoutIds.add(id);
  }

  _retryOpenAnimation() {
    if (!this._canAnimate()) {
      this.cancel(true);
      return;
    }

    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
      this._removeTimeout(id);
      if (this._opened && this._canAnimate()) this._animateOpen();
      return GLib.SOURCE_REMOVE;
    });
    this._timeoutIds.add(id);
  }

  _getGrid() {
    const appDisplay = Main.overview?._overview?.controls?._appDisplay ?? null;
    const grid = appDisplay?._grid ?? null;
    const layout = grid?.layoutManager ?? grid?.layout_manager ?? null;

    if (!appDisplay || !grid || !layout) return null;
    this._disableGridClippingFor(appDisplay, grid);
    return { appDisplay, grid, layout };
  }

  _disableGridClipping() {
    const appDisplay = Main.overview?._overview?.controls?._appDisplay ?? null;
    const grid = appDisplay?._grid ?? null;

    if (appDisplay && grid) this._disableGridClippingFor(appDisplay, grid);
  }

  _disableGridClippingFor(appDisplay, grid) {
    const actors = new Set([
      appDisplay,
      grid,
      appDisplay._box,
      grid.get_parent?.(),
    ]);

    for (let actor = grid; actor; actor = actor.get_parent?.()) {
      actors.add(actor);
      if (actor === appDisplay) break;
    }

    for (const actor of actors) {
      if (!actor || actor.is_destroyed?.()) continue;
      if (!this._clipStates.has(actor))
        this._clipStates.set(actor, actor.clip_to_allocation ?? false);

      try {
        actor.clip_to_allocation = false;
      } catch (_) {}
    }
  }

  _restoreGridClipping() {
    for (const [actor, clipToAllocation] of this._clipStates) {
      try {
        if (!actor.is_destroyed?.())
          actor.clip_to_allocation = clipToAllocation;
      } catch (_) {}
    }

    this._clipStates.clear();
  }

  _getVisiblePageIcons() {
    const info = this._getGrid();
    if (!info) return [];

    const { appDisplay, grid } = info;

    if (!appDisplay.mapped || !grid.mapped) return [];

    const page = grid.currentPage ?? 0;
    const items = grid.getItemsAtPage?.(page) ?? [];

    return items.filter((item) => item.visible && !item.is_destroyed?.());
  }

  _getAnimationData() {
    const info = this._getGrid();
    if (!info) return null;

    const { appDisplay, grid, layout } = info;
    if (!appDisplay.mapped || !grid.mapped) return null;

    const page = grid.currentPage ?? 0;
    const icons = (grid.getItemsAtPage?.(page) ?? []).filter(
      (item) => item.visible && !item.is_destroyed?.(),
    );

    if (!icons.length) return null;

    const pageWidth = layout.pageWidth ?? layout.page_width ?? grid.width;
    const pageHeight = layout.pageHeight ?? layout.page_height ?? grid.height;
    const centerX = page * pageWidth + pageWidth / 2;
    const centerY = pageHeight / 2;
    let maxDistance = 1;

    const records = [];

    for (const icon of icons) {
      const box = icon.allocation;
      const x1 = box?.x1 ?? 0;
      const y1 = box?.y1 ?? 0;
      const width = box?.get_width?.() ?? (box ? box.x2 - box.x1 : icon.width);
      const height =
        box?.get_height?.() ?? (box ? box.y2 - box.y1 : icon.height);

      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      if (width <= 0 || height <= 0) return null;

      const x2 = box?.x2 ?? x1 + width;
      const y2 = box?.y2 ?? y1 + height;
      const iconX = (x1 + x2) / 2;
      const iconY = (y1 + y2) / 2;
      const distance = Math.hypot(iconX - centerX, iconY - centerY);

      maxDistance = Math.max(maxDistance, distance);
      records.push({ icon, iconX, iconY, distance });
    }

    return { centerX, centerY, maxDistance, records };
  }

  _hideIcons(clearAnimations = true) {
    if (clearAnimations) this._clearTimeouts();

    for (const icon of this._getVisiblePageIcons()) {
      icon.remove_all_transitions?.();
      icon.opacity = 0;
    }
  }

  _restoreIcons() {
    for (const icon of this._getVisiblePageIcons()) {
      icon.remove_all_transitions?.();
      icon.translation_x = 0;
      icon.translation_y = 0;
      icon.scale_x = 1;
      icon.scale_y = 1;
      icon.opacity = 255;
    }
  }

  _animateOpen() {
    if (!this._canAnimate()) {
      this.cancel(true);
      return;
    }

    const data = this._getAnimationData();

    if (!data) {
      this._hideIcons(false);
      this._retryOpenAnimation();
      return;
    }

    this._clearTimeouts();
    this._animating = true;

    for (const record of data.records) {
      const { icon, iconX, iconY, distance } = record;
      const dx = (iconX - data.centerX) * (APP_GRID_ANIMATION_START_SCALE - 1);
      const dy = (iconY - data.centerY) * (APP_GRID_ANIMATION_START_SCALE - 1);
      const delay = Math.round(
        (distance / data.maxDistance) * APP_GRID_ANIMATION_DELAY_RATIO,
      );

      this._prepareIcon(icon, dx, dy, APP_GRID_ANIMATION_START_SCALE, 0);
      this._easeIcon({
        icon,
        fromX: dx,
        fromY: dy,
        fromScale: APP_GRID_ANIMATION_START_SCALE,
        toX: 0,
        toY: 0,
        toScale: 1,
        fromOpacity: 0,
        toOpacity: 255,
        delay,
      });
    }
  }

  _animateClose() {
    if (!this._canAnimate()) {
      this.cancel(true);
      return;
    }

    const data = this._getAnimationData();

    if (!data) {
      this._hideIcons();
      return;
    }

    this._clearTimeouts();

    for (const record of data.records) {
      const { icon, iconX, iconY, distance } = record;
      const dx = (iconX - data.centerX) * (APP_GRID_ANIMATION_START_SCALE - 1);
      const dy = (iconY - data.centerY) * (APP_GRID_ANIMATION_START_SCALE - 1);
      const delay = Math.round(
        (1 - distance / data.maxDistance) * APP_GRID_ANIMATION_DELAY_RATIO,
      );

      this._prepareIcon(icon, 0, 0, 1, 255);
      this._easeIcon({
        icon,
        fromX: 0,
        fromY: 0,
        fromScale: 1,
        toX: dx,
        toY: dy,
        toScale: APP_GRID_ANIMATION_START_SCALE,
        fromOpacity: 255,
        toOpacity: 0,
        delay,
        onComplete: () => {
          icon.opacity = 0;
        },
      });
    }
  }

  _prepareIcon(icon, translationX, translationY, scale, opacity) {
    icon.remove_all_transitions?.();
    icon.set_pivot_point?.(0.5, 0.5);
    icon.translation_x = translationX;
    icon.translation_y = translationY;
    icon.scale_x = scale;
    icon.scale_y = scale;
    icon.opacity = opacity;
  }

  _easeIcon({
    icon,
    fromX,
    fromY,
    fromScale,
    toX,
    toY,
    toScale,
    fromOpacity,
    toOpacity,
    delay,
    onComplete = null,
  }) {
    const start = () => {
      const startTime = GLib.get_monotonic_time();
      const progressedCubic = _getProgressedCubic(
        APP_GRID_ANIMATION_BEZIER,
        APP_GRID_ANIMATION_DURATION + delay * (delay * 0.06),
      );
      let frameId = 0;

      frameId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        APP_GRID_ANIMATION_FRAME_INTERVAL,
        () => {
          if (icon.is_destroyed?.()) {
            this._removeTimeout(frameId);
            return GLib.SOURCE_REMOVE;
          }

          const elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          const eased = _progressFromCubicTable(progressedCubic, elapsed);
          const inv = 1 - eased;

          icon.translation_x = fromX * inv + toX * eased;
          icon.translation_y = fromY * inv + toY * eased;
          icon.scale_x = fromScale * inv + toScale * eased;
          icon.scale_y = fromScale * inv + toScale * eased;
          icon.opacity = Math.clamp(
            Math.round(fromOpacity * inv + toOpacity * eased),
            0,
            255,
          );

          if (elapsed < APP_GRID_ANIMATION_DURATION + delay * (delay * 0.06))
            return GLib.SOURCE_CONTINUE;

          icon.translation_x = toX;
          icon.translation_y = toY;
          icon.scale_x = toScale;
          icon.scale_y = toScale;
          icon.opacity = toOpacity;
          onComplete?.();
          this._removeTimeout(frameId);
          return GLib.SOURCE_REMOVE;
        },
      );

      this._timeoutIds.add(frameId);
      return GLib.SOURCE_REMOVE;
    };

    if (delay <= 0) {
      start();
      return;
    }

    let delayId = 0;
    delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this._removeTimeout(delayId);
      start();
      return GLib.SOURCE_REMOVE;
    });
    this._timeoutIds.add(delayId);
  }

  _clearTimeouts() {
    if (!this._timeoutIds) return;

    for (const id of this._timeoutIds) {
      try {
        GLib.source_remove(id);
      } catch (_) {}
    }

    this._timeoutIds.clear();
  }

  _removeTimeout(id) {
    this._timeoutIds?.delete(id);
  }
}

class OriginSegmentedControl {
  constructor(tab1Label, tab2Label, onChanged) {
    this.actor = new St.Widget({
      style_class: "originuicc-app-library-switch",
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: true,
      width: APP_LIBRARY_SWITCH_WIDTH,
      height: APP_LIBRARY_SWITCH_HEIGHT,
    });

    this._indicatorTrack = new St.Widget({
      style_class: "originuicc-app-library-switch-indicator-track",
      layout_manager: new Clutter.FixedLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      width: APP_LIBRARY_SWITCH_TAB_WIDTH * 2,
      height: APP_LIBRARY_SWITCH_TAB_HEIGHT,
      reactive: false,
    });

    this._indicator = new St.Widget({
      style_class: "originuicc-app-library-switch-indicator",
      width: APP_LIBRARY_SWITCH_TAB_WIDTH,
      height: APP_LIBRARY_SWITCH_TAB_HEIGHT,
      reactive: false,
    });

    this._tabs = new St.BoxLayout({
      style_class: "originuicc-app-library-switch-tabs",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      width: APP_LIBRARY_SWITCH_TAB_WIDTH * 2,
      height: APP_LIBRARY_SWITCH_TAB_HEIGHT,
    });

    this._buttons = [
      this._createButton(tab1Label, APP_LIBRARY_TAB_ALL, onChanged),
      this._createButton(tab2Label, APP_LIBRARY_TAB_ARRANGED, onChanged),
    ];

    this._indicatorTrack.add_child(this._indicator);
    this._tabs.add_child(this._buttons[0]);
    this._tabs.add_child(this._buttons[1]);
    this.actor.add_child(this._indicatorTrack);
    this.actor.add_child(this._tabs);

    this.setActive(APP_LIBRARY_TAB_ALL, false);
  }

  destroy() {
    this.actor.destroy();
  }

  _createButton(label, index, onChanged) {
    const button = new St.Button({
      style_class: "originuicc-app-library-switch-tab",
      label,
      can_focus: true,
      width: APP_LIBRARY_SWITCH_TAB_WIDTH,
      height: APP_LIBRARY_SWITCH_TAB_HEIGHT,
    });

    button.connect("clicked", () => onChanged(index));
    return button;
  }

  setActive(index, animate = true) {
    this._activeIndex = index;

    for (let i = 0; i < this._buttons.length; i++) {
      if (i === index) this._buttons[i].add_style_pseudo_class("checked");
      else this._buttons[i].remove_style_pseudo_class("checked");
    }

    const targetX = index * APP_LIBRARY_SWITCH_TAB_WIDTH;
    this._indicator.remove_all_transitions?.();

    if (!animate) {
      this._indicator.x = targetX;
      return;
    }

    _easeActor(this._indicator, { x: targetX }, { duration: 220 });
  }
}

class OriginArrangedAppGrid {
  constructor() {
    this.actor = new St.Widget({
      style_class: "originuicc-arranged-app-grid",
      layout_manager: new Clutter.FixedLayout(),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
      visible: false,
    });

    this._pageBin = new St.Widget({
      style_class: "originuicc-arranged-page-bin",
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
      clip_to_allocation: false,
    });

    this._prevButton = this._createNavButton(
      "carousel-arrow-previous-symbolic",
      "previous",
      () => this.goToPage(this._currentPage - 1),
    );
    this._nextButton = this._createNavButton(
      "carousel-arrow-next-symbolic",
      "next",
      () => this.goToPage(this._currentPage + 1),
    );

    this._navLayer = new St.Widget({
      style_class: "originuicc-arranged-nav-layer",
      layout_manager: new Clutter.FixedLayout(),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
      reactive: false,
    });

    this._pageIndicators = new St.BoxLayout({
      style_class: "originuicc-arranged-page-indicators",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.END,
      x_expand: false,
      y_expand: false,
    });

    this.actor.add_child(this._pageBin);
    this._navLayer.add_child(this._prevButton);
    this._navLayer.add_child(this._nextButton);
    this.actor.add_child(this._navLayer);
    this.actor.add_child(this._pageIndicators);

    this._folders = [];
    this._pages = [];
    this._pageActors = [];
    this._currentPage = 0;
    this._openFolderOverlay = null;
    this._suspendPageActorSync = false;

    this.actor.connect("notify::allocation", () => {
      this._syncShellPositions();

      if (this._openFolderOverlay) {
        const { overlay, clone, iconLayer, content, surfaceLayer } =
          this._openFolderOverlay;
        this._syncOpenOverlayGeometry(overlay, clone, iconLayer, content);
        if (surfaceLayer?.width === clone._originuiccTargetWidth)
          this._syncOpenContentGeometry(clone, surfaceLayer, content);
      }

      if (!this._suspendPageActorSync) this._syncPageActors(false);
    });
  }

  destroy() {
    this._closeOpenFolder(false);
    this.actor.destroy();
  }

  rebuild(appRecords) {
    this._closeOpenFolder(false);
    this._folders = this._buildFolders(appRecords);
    this._pages = [];
    this._pageActors = [];
    this._pageBin.destroy_all_children();

    for (let i = 0; i < this._folders.length; i += ARRANGED_FOLDERS_PER_PAGE)
      this._pages.push(this._folders.slice(i, i + ARRANGED_FOLDERS_PER_PAGE));

    if (this._pages.length === 0) this._pages.push([]);

    this._currentPage = Math.clamp(
      this._currentPage,
      0,
      Math.max(this._pages.length - 1, 0),
    );

    for (const folders of this._pages) {
      const pageActor = this._createPageActor(folders);
      this._pageActors.push(pageActor);
      this._pageBin.add_child(pageActor);
    }

    this._syncPageActors(false);
    this._syncNavigation();
    this._syncShellPositions();
  }

  goToPage(pageIndex) {
    const page = Math.clamp(pageIndex, 0, Math.max(this._pages.length - 1, 0));

    if (page === this._currentPage) return;

    this._currentPage = page;
    this._syncPageActors(true);
    this._syncNavigation();
    this._syncShellPositions();
  }

  _createNavButton(iconName, side, onClicked) {
    const button = new St.Button({
      style_class: `originuicc-arranged-nav-button ${side}`,
      child: new St.Icon({
        icon_name: iconName,
        icon_size: 24,
      }),
      x_align:
        side === "previous" ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      can_focus: true,
    });

    button.connect("clicked", onClicked);
    return button;
  }

  _syncShellPositions() {
    const width = this.actor.allocation?.get_width?.() || this.actor.width || 0;
    const height =
      this.actor.allocation?.get_height?.() || this.actor.height || 0;

    if (width <= 0 || height <= 0) return;

    this._pageBin.set_position(0, 0);
    this._pageBin.set_size(width, height);
    this._navLayer.set_position(0, 0);
    this._navLayer.set_size(width, height);

    this._prevButton.set_position(
      ARRANGED_NAV_SIDE_MARGIN,
      Math.round((height - ARRANGED_NAV_BUTTON_SIZE) / 2),
    );
    this._nextButton.set_position(
      Math.max(
        ARRANGED_NAV_SIDE_MARGIN,
        width - ARRANGED_NAV_SIDE_MARGIN - ARRANGED_NAV_BUTTON_SIZE,
      ),
      Math.round((height - ARRANGED_NAV_BUTTON_SIZE) / 2),
    );

    const hasMultiplePages = this._pages.length > 1;
    const indicatorWidth = hasMultiplePages
      ? this._pages.length * ARRANGED_PAGE_INDICATOR_DOT_SIZE +
        Math.max(0, this._pages.length - 1) *
          ARRANGED_PAGE_INDICATOR_DOT_SPACING
      : 1;
    const indicatorHeight = ARRANGED_PAGE_INDICATOR_DOT_SIZE;

    this._pageIndicators.set_position(
      Math.round((width - indicatorWidth) / 2),
      Math.max(0, height - indicatorHeight - ARRANGED_PAGE_INDICATOR_BOTTOM),
    );
  }

  _buildFolders(appRecords) {
    const folders = ARRANGED_FOLDER_RULES.map((rule) => ({
      key: rule.key,
      title: rule.title,
      apps: [],
    }));
    const otherFolder = {
      key: "other",
      title: "Other",
      apps: [],
    };

    for (const record of appRecords) {
      const index = ARRANGED_FOLDER_RULES.findIndex((rule) =>
        _appMatchesRule(record.appInfo, rule),
      );

      if (index >= 0) folders[index].apps.push(record.app);
      else otherFolder.apps.push(record.app);
    }

    return [...folders, otherFolder].filter((folder) => folder.apps.length > 0);
  }

  _syncPageActors(animate = true) {
    if (this._openFolderOverlay) return;

    const width = this._getPageTravelWidth();
    const duration = animate ? ARRANGED_PAGE_ANIMATION_TIME : 0;

    this._pageActors.forEach((pageActor, pageIndex) => {
      const distance = pageIndex - this._currentPage;
      const isNeighbor = Math.abs(distance) === 1;
      const isVisible = Math.abs(distance) <= 1;
      const translationX = Math.round(
        distance * width * ARRANGED_SIDE_PAGE_OFFSET_RATIO,
      );
      const opacity =
        distance === 0 ? 255 : isNeighbor ? ARRANGED_SIDE_PAGE_OPACITY : 0;
      const scale = distance === 0 ? 1 : ARRANGED_SIDE_PAGE_SCALE;

      pageActor.remove_all_transitions();
      pageActor.set_pivot_point(0.5, 0.5);

      if (!animate) {
        pageActor.visible = isVisible;
        pageActor.translation_x = translationX;
        pageActor.opacity = opacity;
        pageActor.scale_x = scale;
        pageActor.scale_y = scale;
        return;
      }

      if (isVisible) pageActor.show();

      _easeActor(
        pageActor,
        {
          translation_x: translationX,
          opacity,
          scale_x: scale,
          scale_y: scale,
        },
        {
          duration,
          onComplete: () => {
            pageActor.visible = isVisible;
          },
        },
      );
    });
  }

  _getPageTravelWidth() {
    const allocationWidth = this.actor.allocation?.get_width?.() ?? 0;
    const monitorWidth = Main.layoutManager.primaryMonitor?.width ?? 1280;

    return Math.max(allocationWidth, monitorWidth);
  }

  _createPageActor(folders) {
    const page = new St.BoxLayout({
      style_class: "originuicc-arranged-page",
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    for (let rowIndex = 0; rowIndex < 2; rowIndex++) {
      const row = new St.BoxLayout({
        style_class: "originuicc-arranged-folder-row",
        x_align: Clutter.ActorAlign.CENTER,
      });

      for (let columnIndex = 0; columnIndex < 4; columnIndex++) {
        const folder = folders[rowIndex * 4 + columnIndex];
        row.add_child(
          folder ? this._createFolderActor(folder) : this._createSpacer(),
        );
      }

      page.add_child(row);
    }

    return page;
  }

  _createSpacer() {
    return new St.Widget({
      style_class: "originuicc-arranged-folder-spacer",
      reactive: false,
    });
  }

  _createFolderActor(folder) {
    const folderActor = new St.BoxLayout({
      style_class: "originuicc-arranged-folder",
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: false,
      clip_to_allocation: false,
    });

    const preview = this._createFolderPreview(folder, {
      styleClass: "originuicc-arranged-folder-preview",
      openFolder:
        folder.apps.length > 4
          ? (sourceActor) => this._openFolder(folder, sourceActor, folderActor)
          : null,
    });

    const label = new St.Label({
      style_class: "originuicc-arranged-folder-label",
      text: folder.title,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    folderActor.add_child(preview);
    folderActor.add_child(label);

    return folderActor;
  }

  _createFolderPreview(folder, params = {}) {
    const preview = new St.Widget({
      style_class: params.styleClass ?? "originuicc-arranged-folder-preview",
      layout_manager: new Clutter.FixedLayout(),
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: false,
      width: CLOSED_FOLDER_PREVIEW_SIZE,
      height: CLOSED_FOLDER_PREVIEW_SIZE,
    });
    preview._previewCells = [];

    for (let index = 0; index < 4; index++) {
      let cell;

      if (folder.apps.length > 4 && index === 3)
        cell = this._createMoreAppsCell(
          folder.apps.slice(3, 10),
          params.openFolder,
        );
      else if (folder.apps[index])
        cell = this._createClosedAppCell(folder.apps[index]);
      else cell = this._createEmptyCell();

      const column = index % 2;
      const row = Math.floor(index / 2);
      cell.x =
        CLOSED_FOLDER_PREVIEW_PADDING +
        column * (CLOSED_FOLDER_CELL_SIZE + CLOSED_FOLDER_CELL_SPACING);
      cell.y =
        CLOSED_FOLDER_PREVIEW_PADDING +
        row * (CLOSED_FOLDER_CELL_SIZE + CLOSED_FOLDER_CELL_SPACING);

      preview._previewCells.push(cell);
      preview.add_child(cell);
    }

    return preview;
  }

  _createClosedAppCell(app) {
    const icon = _createIconTexture(app, 52);
    const button = new St.Button({
      style_class: "originuicc-arranged-app-cell",
      can_focus: true,
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      width: CLOSED_FOLDER_CELL_SIZE,
      height: CLOSED_FOLDER_CELL_SIZE,
      child: icon,
    });

    let appActivated = false;
    const activateApp = () => {
      if (appActivated) return Clutter.EVENT_STOP;

      appActivated = true;
      app.activate();
      Main.overview.hide();
      return Clutter.EVENT_STOP;
    };

    button.connect("clicked", activateApp);
    button.connect("button-release-event", activateApp);
    this._addIconHoverAnimation(button, icon);
    return button;
  }

  _createMoreAppsCell(apps, onClicked = null) {
    const cell = new St.Button({
      style_class: "originuicc-arranged-app-cell originuicc-arranged-more-cell",
      can_focus: !!onClicked,
      reactive: !!onClicked,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      width: CLOSED_FOLDER_CELL_SIZE,
      height: CLOSED_FOLDER_CELL_SIZE,
    });
    const content = new St.Widget({
      style_class: "originuicc-arranged-more-content",
      layout_manager: new Clutter.FixedLayout(),
      reactive: false,
      width: CLOSED_FOLDER_CELL_SIZE,
      height: CLOSED_FOLDER_CELL_SIZE,
    });
    content._miniIconCells = [];

    if (onClicked)
      cell.connect("clicked", () => {
        onClicked(cell);
        return Clutter.EVENT_STOP;
      });

    for (let index = 0; index < 4; index++) {
      const app = apps[index];
      const iconBin = new St.Bin({
        style_class: "originuicc-arranged-more-icon",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false,
        width: 22,
        height: 22,
      });
      iconBin._originuiccMiniIcon = true;
      iconBin._originuiccSourceIconSize = 20;

      iconBin.x = 3 + (index % 2) * 26;
      iconBin.y = 3 + Math.floor(index / 2) * 26;

      if (app) iconBin.child = _createIconTexture(app, 20);

      content._miniIconCells.push(iconBin);
      content.add_child(iconBin);
    }

    cell.child = content;
    cell._miniIconCells = content._miniIconCells;
    return cell;
  }

  _createEmptyCell() {
    return new St.Widget({
      style_class:
        "originuicc-arranged-app-cell originuicc-arranged-empty-cell",
      reactive: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      width: 52,
      height: 52,
    });
  }

  _addIconHoverAnimation(button, icon) {
    icon.set_pivot_point?.(0.5, 0.5);

    button.connect("enter-event", () => {
      icon.remove_all_transitions?.();
      _easeActor(
        icon,
        { scale_x: 1.1, scale_y: 1.1 },
        { duration: ICON_HOVER_IN_TIME, cubic: ORIGIN_BOUNCE_CUBIC },
      );
    });

    button.connect("leave-event", () => {
      icon.remove_all_transitions?.();
      _easeActor(
        icon,
        { scale_x: 1, scale_y: 1 },
        { duration: ICON_HOVER_OUT_TIME, cubic: ORIGIN_DEFAULT_CUBIC },
      );
    });
  }

  _openFolder(folder, sourceActor, folderActor = null) {
    this._closeOpenFolder(false);

    const sourcePreview =
      this._getPreviewFromSourceActor(sourceActor) ?? sourceActor;
    const sourcePreviewFrame = this._getActorStageFrame(sourcePreview);
    const sourceIconFrames = this._capturePreviewIconStageFrames(sourcePreview);
    const { width, height } = this._getOpenFolderSize();
    const overlay = new St.Widget({
      style_class: "originuicc-arranged-folder-open-overlay",
      layout_manager: new Clutter.FixedLayout(),
      reactive: true,
      x_expand: false,
      y_expand: false,
      clip_to_allocation: false,
      opacity: 255,
    });
    const pageActorStates = this._capturePageActorStates();
    const clone = new St.Widget({
      style_class: "originuicc-arranged-folder-open-clone",
      layout_manager: new Clutter.FixedLayout(),
      width,
      height,
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.START,
      reactive: true,
    });
    clone._originuiccTargetWidth = width;
    clone._originuiccTargetHeight = height;
    clone.set_size(width, height);
    const surfaceLayer = new St.Widget({
      style_class: "originuicc-arranged-folder-open-surface",
      x_expand: false,
      y_expand: false,
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.START,
      reactive: false,
    });
    const iconLayer = new St.Widget({
      style_class: "originuicc-arranged-folder-open-icon-layer",
      layout_manager: new Clutter.FixedLayout(),
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
      reactive: true,
      clip_to_allocation: false,
    });
    const content = new St.BoxLayout({
      style_class: "originuicc-arranged-folder-open-content",
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    const title = new St.Label({
      style_class: "originuicc-arranged-folder-open-title",
      text: folder.title,
      x_align: Clutter.ActorAlign.CENTER,
      opacity: 0,
    });
    const appGrid = this._createOpenFolderAppGrid(
      folder.apps,
      iconLayer,
      clone,
    );
    appGrid.scrollView.vscrollbar_policy = St.PolicyType.NEVER;
    const forwardScroll = (event) =>
      this._scrollOpenFolder(appGrid.scrollView, appGrid.icons, event);
    overlay.connect("scroll-event", (_actor, event) => forwardScroll(event));
    iconLayer.connect("scroll-event", (_actor, event) => forwardScroll(event));
    clone.connect("scroll-event", (_actor, event) => forwardScroll(event));
    appGrid.actor.connect("scroll-event", (_actor, event) =>
      forwardScroll(event),
    );
    for (const { iconActor } of appGrid.icons)
      iconActor.connect("scroll-event", (_actor, event) =>
        forwardScroll(event),
      );
    const adjustmentSignalId = appGrid.scrollView.vadjustment.connect(
      "notify::value",
      () => this._syncFlyingIconSlots(appGrid.icons),
    );

    content.add_child(title);
    content.add_child(appGrid.actor);
    clone.add_child(surfaceLayer);
    clone.add_child(content);
    overlay.add_child(clone);
    overlay.add_child(iconLayer);
    this.actor.add_child(overlay);
    this._syncOpenOverlayGeometry(overlay, clone, iconLayer, content);
    this._syncOpenContentGeometry(clone, surfaceLayer, content);
    this._syncCloneSurfaceSourceStyle(surfaceLayer);
    this._positionSurfaceFromFrame(surfaceLayer, clone, sourcePreviewFrame);
    this._openFolderOverlay = {
      overlay,
      clone,
      iconLayer,
      sourcePreviewFrame,
      sourceIconFrames,
      folderActor,
      title,
      content,
      stageCapturedEventId: 0,
      pageActorStates,
      appIcons: appGrid.icons,
      surfaceLayer,
      scrollView: appGrid.scrollView,
      scrollAdjustment: appGrid.scrollView.vadjustment,
      adjustmentSignalId,
      openScrollbarTimeoutId: 0,
    };

    if (folderActor) folderActor.opacity = 0;

    overlay.opacity = 255;
    this._animatePageActorsForFolderOpen(true);
    this._openFolderOverlay.openScrollbarTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FOLDER_OPEN_ANIMATION_TIME,
      () => {
        if (this._openFolderOverlay?.scrollView === appGrid.scrollView)
          appGrid.scrollView.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        return GLib.SOURCE_REMOVE;
      },
    );
    this._animateOpenFolderSurface(surfaceLayer, clone);
    _easeActor(
      title,
      { opacity: 255 },
      { duration: FOLDER_OPEN_ANIMATION_TIME, cubic: FOLDER_OPEN_CUBIC },
    );

    this._animateOpenFolderIcons(
      iconLayer,
      surfaceLayer,
      appGrid.icons,
      sourceIconFrames,
    );

    overlay.connect("button-press-event", (_actor, event) =>
      this._handleOpenFolderButtonPress(event),
    );
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this._openFolderOverlay?.overlay === overlay) {
        this._openFolderOverlay.stageCapturedEventId = global.stage.connect(
          "captured-event",
          (_actor, event) => this._handleOpenFolderCapturedEvent(event),
        );
      }

      return GLib.SOURCE_REMOVE;
    });
  }

  _closeOpenFolder(animate = true) {
    const state = this._openFolderOverlay;

    if (!state) return;

    this._openFolderOverlay = null;

    const {
      overlay,
      clone,
      sourcePreviewFrame,
      sourceIconFrames,
      folderActor,
      title,
      content,
      stageCapturedEventId = 0,
      pageActorStates,
      appIcons,
      surfaceLayer,
      scrollView,
      scrollAdjustment,
      adjustmentSignalId,
      openScrollbarTimeoutId,
    } = state;

    overlay.remove_all_transitions?.();
    if (stageCapturedEventId) {
      try {
        global.stage.disconnect(stageCapturedEventId);
      } catch (_) {}
    }
    if (openScrollbarTimeoutId) {
      try {
        GLib.source_remove(openScrollbarTimeoutId);
      } catch (_) {}
    }
    if (scrollView) scrollView.vscrollbar_policy = St.PolicyType.NEVER;

    if (scrollAdjustment && adjustmentSignalId) {
      try {
        scrollAdjustment.disconnect(adjustmentSignalId);
      } catch (_) {}
    }

    if (!animate) {
      overlay.destroy();

      if (folderActor) folderActor.opacity = 255;

      this._restorePageActors(pageActorStates, false);
      return;
    }

    if (folderActor) folderActor.opacity = 0;
    this._restorePageActors(pageActorStates, true);
    this._animateCloseFolderIcons(appIcons, surfaceLayer, sourceIconFrames);
    if (title)
      _easeActor(
        title,
        { opacity: 0 },
        { duration: FOLDER_CLOSE_ANIMATION_TIME, cubic: FOLDER_CLOSE_CUBIC },
      );

    const targetFrame = this._getSurfaceSourceFrameRelative(
      clone,
      sourcePreviewFrame,
    );
    _easeActor(
      surfaceLayer,
      {
        translation_x: targetFrame.x,
        translation_y: targetFrame.y,
        width: targetFrame.width,
        height: targetFrame.height,
      },
      {
        duration: FOLDER_CLOSE_ANIMATION_TIME,
        cubic: FOLDER_CLOSE_CUBIC,
        cancel: false,
      },
    );

    const lastIconDelay =
      (FOLDER_OPEN_VISIBLE_ICON_COUNT +
        FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS +
        1) *
      FOLDER_OPEN_ICON_DELAY;
    const totalCloseAnimationTime = lastIconDelay + FOLDER_CLOSE_ANIMATION_TIME;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, totalCloseAnimationTime, () => {
      if (folderActor && !folderActor.is_destroyed?.())
        folderActor.opacity = 255;
      if (!overlay.is_destroyed?.()) overlay.destroy();
      return GLib.SOURCE_REMOVE;
    });
  }

  _syncOpenOverlayGeometry(overlay, clone, iconLayer, content = null) {
    const width = this.actor.allocation?.get_width?.() || this.actor.width || 0;
    const height =
      this.actor.allocation?.get_height?.() || this.actor.height || 0;

    if (width <= 0 || height <= 0) return;

    const cloneSize = this._getCloneTargetSize(clone);

    overlay.set_position(0, 0);
    overlay.set_size(width, height);
    iconLayer.set_position(0, 0);
    iconLayer.set_size(width, height);
    clone.set_size(cloneSize.width, cloneSize.height);
    clone.set_position(
      Math.round((width - cloneSize.width) / 2),
      Math.round((height - cloneSize.height) / 2),
    );

    if (content) {
      content.set_position(0, 0);
      content.set_size(cloneSize.width, cloneSize.height);
    }
  }

  _handleOpenFolderButtonPress(event) {
    const target = event.get_source?.();
    const state = this._openFolderOverlay;

    if (!state) return Clutter.EVENT_PROPAGATE;

    if (
      target !== state.iconLayer &&
      this._isActorOrDescendant(target, state.iconLayer)
    )
      return Clutter.EVENT_PROPAGATE;

    this._closeOpenFolder(true);
    return Clutter.EVENT_STOP;
  }

  _handleOpenFolderCapturedEvent(event) {
    const type = event.type?.();

    if (type !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;

    return this._handleOpenFolderButtonPress(event);
  }

  _getOpenFolderSize() {
    const allocationHeight = this.actor.allocation?.get_height?.() ?? 0;
    const monitor = Main.layoutManager.primaryMonitor;
    const fallbackHeight = Math.round((monitor?.height ?? 900) * 0.48);
    const height = Math.max(
      420,
      Math.round(allocationHeight * 0.84) || fallbackHeight,
    );

    return {
      height,
      width: Math.round(height * 1.2),
    };
  }

  _animateOpenFolderSurface(surfaceLayer, clone) {
    surfaceLayer.remove_all_transitions?.();

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (surfaceLayer.is_destroyed?.()) return GLib.SOURCE_REMOVE;

      const finalSurfaceFrame = this._getFinalSurfaceFrame(clone);
      _easeActor(
        surfaceLayer,
        {
          translation_x: finalSurfaceFrame.x,
          translation_y: finalSurfaceFrame.y,
          width: finalSurfaceFrame.width,
          height: finalSurfaceFrame.height,
        },
        {
          duration: FOLDER_OPEN_ANIMATION_TIME,
          cubic: FOLDER_OPEN_CUBIC,
          cancel: false,
        },
      );

      return GLib.SOURCE_REMOVE;
    });
  }

  _syncOpenContentGeometry(clone, surfaceLayer, content) {
    const { width, height } = this._getCloneTargetSize(clone);

    content.set_position(0, 0);
    content.set_size(width, height);

    const scrollView = content.get_child_at_index?.(1);

    if (scrollView) {
      const titleHeight = 50;
      const bottomPadding = 20;

      scrollView.set_position(0, titleHeight);
      scrollView.set_size(
        width,
        Math.max(0, height - titleHeight - bottomPadding),
      );
    }

    if (
      surfaceLayer.width === width &&
      surfaceLayer.height === height &&
      surfaceLayer.translation_x === 0 &&
      surfaceLayer.translation_y === 0
    )
      surfaceLayer.set_position(0, 0);
  }

  _positionSurfaceFromFrame(surfaceLayer, clone, sourceFrame) {
    const frame = this._getSurfaceSourceFrameRelative(clone, sourceFrame);

    surfaceLayer.set_position(0, 0);
    surfaceLayer.set_size(frame.width, frame.height);
    surfaceLayer.translation_x = frame.x;
    surfaceLayer.translation_y = frame.y;
  }

  _getFinalSurfaceFrame(clone) {
    const { width, height } = this._getCloneTargetSize(clone);

    return { x: 0, y: 0, width, height };
  }

  _syncCloneSurfaceSourceStyle(surfaceLayer) {
    surfaceLayer.set_style(`border-radius: ${CLOSED_FOLDER_PREVIEW_RADIUS}px;`);
  }

  _getSurfaceSourceFrameRelative(clone, sourceFrame) {
    // Stage position của grid/container hiện tại.
    // Không lấy transform của clone.
    const [gridStageX, gridStageY] = this.actor.get_transformed_position();

    const gridWidth =
      this.actor.allocation?.get_width?.() || this.actor.width || 0;

    const gridHeight =
      this.actor.allocation?.get_height?.() || this.actor.height || 0;

    const { width: cloneWidth, height: cloneHeight } =
      this._getCloneTargetSize(clone);

    // Đây chính là vị trí clone sau khi _syncOpenOverlayGeometry()
    // center nó trong overlay.
    const cloneX = Math.round((gridWidth - cloneWidth) / 2);
    const cloneY = Math.round((gridHeight - cloneHeight) / 2);

    // Frame stage dự kiến của clone.
    const cloneStageX = gridStageX + cloneX;
    const cloneStageY = gridStageY + cloneY;

    return {
      x: Math.round(sourceFrame.x - cloneStageX),
      y: Math.round(sourceFrame.y - cloneStageY),
      width: Math.round(sourceFrame.width),
      height: Math.round(sourceFrame.height),
    };
  }

  _capturePageActorStates() {
    return this._pageActors.map((pageActor) => ({
      pageActor,
      visible: pageActor.visible,
      opacity: pageActor.opacity,
      scaleX: pageActor.scale_x,
      scaleY: pageActor.scale_y,
      translationX: pageActor.translation_x,
      translationY: pageActor.translation_y,
    }));
  }

  _animatePageActorsForFolderOpen(animate) {
    for (const pageActor of this._pageActors) {
      pageActor.remove_all_transitions?.();
      pageActor.set_pivot_point(0.5, 0.5);

      _easeActor(
        pageActor,
        {
          opacity: FOLDER_OPEN_GRID_OPACITY,
          scale_x: FOLDER_OPEN_GRID_SCALE,
          scale_y: FOLDER_OPEN_GRID_SCALE,
        },
        {
          duration: animate ? FOLDER_OPEN_ANIMATION_TIME : 0,
          cubic: FOLDER_OPEN_CUBIC,
        },
      );
    }
  }

  _restorePageActors(states, animate) {
    for (const state of states) {
      const pageActor = state.pageActor;
      if (pageActor.is_destroyed?.()) continue;

      pageActor.remove_all_transitions?.();
      pageActor.visible = state.visible;
      pageActor.set_pivot_point(0.5, 0.5);
      _easeActor(
        pageActor,
        {
          opacity: state.opacity,
          scale_x: state.scaleX,
          scale_y: state.scaleY,
          translation_x: state.translationX,
          translation_y: state.translationY,
        },
        {
          duration: animate ? FOLDER_CLOSE_ANIMATION_TIME : 0,
          cubic: FOLDER_CLOSE_CUBIC,
        },
      );
    }
  }

  _createOpenFolderAppGrid(apps, iconLayer, clone) {
    const grid = new St.BoxLayout({
      style_class: "originuicc-arranged-folder-open-app-grid",
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.START,
    });
    const scrollView = new St.ScrollView({
      style_class: "originuicc-arranged-folder-open-scroll-view",
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      enable_mouse_scrolling: true,
      x_expand: true,
      y_expand: true,
      clip_to_allocation: true,
      child: grid,
    });
    scrollView._originuiccOpenClone = clone;

    const icons = [];
    const columns = 5;

    for (let i = 0; i < apps.length; i += columns) {
      const row = new St.BoxLayout({
        style_class: "originuicc-arranged-folder-open-app-row",
        x_align: Clutter.ActorAlign.CENTER,
      });

      for (let j = 0; j < columns; j++) {
        const app = apps[i + j];
        const slot = app
          ? this._createOpenFolderSlot()
          : this._createOpenFolderSpacer();

        slot._originuiccOpenClone = clone;
        slot._originuiccOpenScrollView = scrollView;
        row.add_child(slot);
        if (app) {
          const iconActor = this._createOpenFolderFlyingIcon(app, iconLayer);
          icons.push({ slot, iconActor, scrollView });
        }
      }

      grid.add_child(row);
    }

    return { actor: scrollView, scrollView, icons };
  }

  _scrollOpenFolder(scrollView, openIcons, event) {
    const adjustment = scrollView?.vadjustment;
    if (!adjustment) return Clutter.EVENT_PROPAGATE;

    let delta = 0;
    const direction = event.get_scroll_direction?.();

    if (direction === Clutter.ScrollDirection.SMOOTH) {
      const [, dy] = event.get_scroll_delta?.() ?? [0, 0];
      delta = dy * 30;
    } else if (
      direction === Clutter.ScrollDirection.DOWN ||
      direction === Clutter.ScrollDirection.RIGHT
    ) {
      delta = 30;
    } else if (
      direction === Clutter.ScrollDirection.UP ||
      direction === Clutter.ScrollDirection.LEFT
    ) {
      delta = -30;
    }

    if (delta === 0) return Clutter.EVENT_PROPAGATE;

    const upper = adjustment.upper ?? 0;
    const pageSize = adjustment.page_size ?? 0;
    const value = Math.clamp(
      adjustment.value + delta,
      0,
      Math.max(0, upper - pageSize),
    );

    if (adjustment.set_value) adjustment.set_value(value);
    else adjustment.value = value;

    this._syncFlyingIconSlots(openIcons);
    return Clutter.EVENT_STOP;
  }

  _syncFlyingIconSlots(openIcons) {
    for (const { slot, iconActor, scrollView } of openIcons) {
      if (!slot.is_destroyed?.() && !iconActor.is_destroyed?.()) {
        const targetFrame = this._placeFlyingIconAtSlot(iconActor, slot);
        this._syncFlyingIconVisibility(iconActor, targetFrame, scrollView);
      }
    }
  }

  _createOpenFolderSlot() {
    return new St.Widget({
      style_class: "originuicc-arranged-folder-open-app-slot",
      reactive: false,
      x_expand: false,
      y_expand: false,
      width: OPEN_FOLDER_ICON_SIZE,
      height: OPEN_FOLDER_ICON_SIZE,
    });
  }

  _createOpenFolderFlyingIcon(app, iconLayer) {
    const icon = _createIconTexture(app, OPEN_FOLDER_ICON_TEXTURE_SIZE);
    const button = new St.Button({
      style_class: "originuicc-arranged-folder-open-flying-icon",
      can_focus: true,
      child: icon,
      opacity: 0,
      reactive: true,
      x_expand: false,
      y_expand: false,
      width: OPEN_FOLDER_ICON_SIZE,
      height: OPEN_FOLDER_ICON_SIZE,
    });

    let appActivated = false;
    const activateApp = () => {
      if (appActivated) return Clutter.EVENT_STOP;

      appActivated = true;
      app.activate();
      Main.overview.hide();
      return Clutter.EVENT_STOP;
    };

    button.connect("clicked", activateApp);
    button.connect("button-release-event", activateApp);
    this._addIconHoverAnimation(button, icon);
    iconLayer.add_child(button);
    return button;
  }

  _createOpenFolderSpacer() {
    return new St.Widget({
      style_class: "originuicc-arranged-folder-open-app-spacer",
      reactive: false,
      x_expand: false,
      y_expand: false,
      width: OPEN_FOLDER_ICON_SIZE,
      height: OPEN_FOLDER_ICON_SIZE,
    });
  }

  _animateOpenFolderIcons(
    iconLayer,
    surfaceLayer,
    openIcons,
    sourceIconFrames,
  ) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (iconLayer.is_destroyed?.() || surfaceLayer.is_destroyed?.())
        return GLib.SOURCE_REMOVE;

      openIcons.forEach(({ slot, iconActor, scrollView }, index) => {
        if (iconActor.is_destroyed?.()) return;

        iconActor.remove_all_transitions?.();
        iconActor.set_pivot_point(0.5, 0.5);
        const targetFrame = this._placeFlyingIconAtSlot(iconActor, slot);
        this._syncFlyingIconVisibility(iconActor, targetFrame, scrollView);

        const delay =
          index <
          FOLDER_OPEN_VISIBLE_ICON_COUNT + FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS
            ? (index + 1) * FOLDER_OPEN_ICON_DELAY
            : (FOLDER_OPEN_VISIBLE_ICON_COUNT +
                FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS +
                1) *
              FOLDER_OPEN_ICON_DELAY;

        if (index < sourceIconFrames.length && sourceIconFrames[index]) {
          const offset = this._getSourceFrameOffset(
            sourceIconFrames[index],
            iconActor.get_parent(),
            targetFrame,
          );
          const scale = this._getFrameScale(sourceIconFrames[index], iconActor);
          iconActor.opacity = 255;
          iconActor.scale_x = scale;
          iconActor.scale_y = scale;
          iconActor.translation_x = offset.x;
          iconActor.translation_y = offset.y;
        } else {
          const offset = this._getSourceFrameOffset(
            sourceIconFrames[3],
            iconActor.get_parent(),
            targetFrame,
          );
          const scale = this._getFrameScale(sourceIconFrames[3], iconActor);
          iconActor.opacity = 0;
          iconActor.scale_x = scale;
          iconActor.scale_y = scale;
          iconActor.translation_x = offset.x;
          iconActor.translation_y = offset.y;
        }

        _easeActor(
          iconActor,
          {
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
          },
          {
            delay,
            duration: FOLDER_OPEN_ANIMATION_TIME,
            cubic: FOLDER_OPEN_CUBIC,
          },
        );
      });

      _easeActor(
        surfaceLayer,
        { opacity: 0 },
        {
          duration: Math.round(
            FOLDER_OPEN_ANIMATION_TIME_OPACITY_CLONE_BACKGROUND,
          ),
          cubic: FOLDER_OPEN_CUBIC,
          cancel: false,
        },
      );

      return GLib.SOURCE_REMOVE;
    });
  }

  _animateCloseFolderIcons(openIcons, surfaceLayer, sourceIconFrames) {
    if (!surfaceLayer.is_destroyed?.()) {
      surfaceLayer.show();
      surfaceLayer.opacity = 0;
      _easeActor(
        surfaceLayer,
        { opacity: 255 },
        {
          duration: Math.round(FOLDER_CLOSE_ANIMATION_TIME / 2),
          cubic: FOLDER_CLOSE_CUBIC,
          cancel: false,
        },
      );
    }

    openIcons.forEach(({ slot, iconActor, scrollView }, index) => {
      if (iconActor.is_destroyed?.()) return;

      iconActor.remove_all_transitions?.();
      const targetFrame = this._placeFlyingIconAtSlot(iconActor, slot);
      this._syncFlyingIconVisibility(iconActor, targetFrame, scrollView);
      if (index < sourceIconFrames.length && sourceIconFrames[index])
        iconActor.visible = true;
      const delay =
        index <
        FOLDER_OPEN_VISIBLE_ICON_COUNT + FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS
          ? (index + 1) * FOLDER_OPEN_ICON_DELAY
          : (FOLDER_OPEN_VISIBLE_ICON_COUNT +
              FOLDER_OPEN_VISIBLE_ICON_COUNT_PLUS +
              1) *
            FOLDER_OPEN_ICON_DELAY;

      if (index < sourceIconFrames.length && sourceIconFrames[index]) {
        const offset = this._getSourceFrameOffset(
          sourceIconFrames[index],
          iconActor.get_parent(),
          targetFrame,
        );
        const scale = this._getFrameScale(sourceIconFrames[index], iconActor);
        _easeActor(
          iconActor,
          {
            opacity: 255,
            scale_x: scale,
            scale_y: scale,
            translation_x: offset.x,
            translation_y: offset.y,
          },
          {
            delay,
            duration: FOLDER_CLOSE_ANIMATION_TIME,
            cubic: FOLDER_CLOSE_CUBIC,
          },
        );
      } else {
        const offset = this._getSourceFrameOffset(
          sourceIconFrames[3],
          iconActor.get_parent(),
          targetFrame,
        );
        const scale = this._getFrameScale(sourceIconFrames[3], iconActor);
        _easeActor(
          iconActor,
          {
            opacity: 0,
            scale_x: scale,
            scale_y: scale,
            translation_x: offset.x,
            translation_y: offset.y,
          },
          {
            delay,
            duration: FOLDER_CLOSE_ANIMATION_TIME,
            cubic: FOLDER_CLOSE_CUBIC,
          },
        );
      }
    });
  }

  _getPreviewFromSourceActor(sourceActor) {
    for (let actor = sourceActor; actor; actor = actor.get_parent?.()) {
      if (actor._previewCells) return actor;
    }

    return null;
  }

  _getPreviewSourceActors(previewLayer) {
    const cells = previewLayer?._previewCells ?? [];
    const sources = cells.slice(0, 3);
    const moreCell = cells[3];

    if (moreCell?._miniIconCells) sources.push(...moreCell._miniIconCells);
    else if (moreCell) sources.push(moreCell);

    return sources.slice(0, FOLDER_OPEN_VISIBLE_ICON_COUNT);
  }

  _capturePreviewIconStageFrames(previewLayer) {
    return this._getPreviewSourceActors(previewLayer)
      .map((actor) => this._getPreviewIconStageFrame(actor))
      .filter((frame) => frame.width > 0 && frame.height > 0);
  }

  _getPreviewIconStageFrame(actor) {
    const frame = this._getActorStageFrame(actor);

    if (actor._originuiccMiniIcon) {
      const size = actor._originuiccSourceIconSize ?? 20;

      return {
        x: frame.x + Math.round((frame.width - size) / 2),
        y: frame.y + Math.round((frame.height - size) / 2),
        width: size,
        height: size,
      };
    }

    return frame;
  }

  _getActorStageFrame(actor) {
    const [x, y] = actor.get_transformed_position();
    const width = actor.allocation?.get_width?.() || actor.width || 1;
    const height = actor.allocation?.get_height?.() || actor.height || 1;

    return { x, y, width, height };
  }

  _placeFlyingIconAtSlot(iconActor, slot) {
    const parent = iconActor.get_parent();
    const slotFrame = this._getFinalActorFrameRelativeToLayer(
      slot,
      parent,
      slot._originuiccOpenClone,
    );
    const scrollView = slot._originuiccOpenScrollView;
    const scrollOffset = scrollView?.vadjustment?.value ?? 0;
    slotFrame.y -= scrollOffset;
    const iconWidth =
      iconActor.allocation?.get_width?.() ||
      iconActor.width ||
      OPEN_FOLDER_ICON_SIZE;
    const iconHeight =
      iconActor.allocation?.get_height?.() ||
      iconActor.height ||
      OPEN_FOLDER_ICON_SIZE;
    const x = slotFrame.x + (slotFrame.width - iconWidth) / 2;
    const y = slotFrame.y + (slotFrame.height - iconHeight) / 2;

    iconActor.set_position(Math.round(x), Math.round(y));
    return { x, y, width: iconWidth, height: iconHeight };
  }

  _getFinalActorFrameRelativeToLayer(actor, layer, clone) {
    if (!clone) return this._getActorFrameRelativeTo(actor, layer);

    const cloneFrame = this._getFinalCloneFrameRelativeToLayer(clone, layer);
    const actorFrame = this._getActorAllocationFrameRelativeToAncestor(
      actor,
      clone,
    );

    return {
      x: cloneFrame.x + actorFrame.x,
      y: cloneFrame.y + actorFrame.y,
      width: actorFrame.width,
      height: actorFrame.height,
    };
  }

  _getFinalCloneFrameRelativeToLayer(clone, layer) {
    const layerWidth = layer.allocation?.get_width?.() || layer.width || 1;
    const layerHeight = layer.allocation?.get_height?.() || layer.height || 1;
    const { width: cloneWidth, height: cloneHeight } =
      this._getCloneTargetSize(clone);

    return {
      x: Math.round((layerWidth - cloneWidth) / 2),
      y: Math.round((layerHeight - cloneHeight) / 2),
      width: cloneWidth,
      height: cloneHeight,
    };
  }

  _getCloneTargetSize(clone) {
    return {
      width:
        clone._originuiccTargetWidth ||
        clone.allocation?.get_width?.() ||
        clone.width ||
        1,
      height:
        clone._originuiccTargetHeight ||
        clone.allocation?.get_height?.() ||
        clone.height ||
        1,
    };
  }

  _getActorAllocationFrameRelativeToAncestor(actor, ancestor) {
    let x = 0;
    let y = 0;
    let width = actor.allocation?.get_width?.() || actor.width || 1;
    let height = actor.allocation?.get_height?.() || actor.height || 1;

    for (
      let current = actor;
      current && current !== ancestor;
      current = current.get_parent?.()
    ) {
      const box = current.allocation;
      let originX = current.x ?? 0;
      let originY = current.y ?? 0;

      if (box?.get_origin) {
        const [allocatedX, allocatedY] = box.get_origin();
        originX = allocatedX;
        originY = allocatedY;
      } else if (box) {
        originX = box.x1 ?? originX;
        originY = box.y1 ?? originY;
      }

      x += originX;
      y += originY;
    }

    return { x, y, width, height };
  }

  _getActorFrameRelativeTo(actor, relativeTo) {
    const [actorX, actorY] = actor.get_transformed_position();
    const [relativeX, relativeY] = relativeTo.get_transformed_position();
    const width = actor.allocation?.get_width?.() || actor.width || 1;
    const height = actor.allocation?.get_height?.() || actor.height || 1;

    return {
      x: actorX - relativeX,
      y: actorY - relativeY,
      width,
      height,
    };
  }

  _syncFlyingIconVisibility(iconActor, targetFrame, scrollView) {
    if (!scrollView) return true;

    const viewportFrame = this._getFinalActorFrameRelativeToLayer(
      scrollView,
      iconActor.get_parent(),
      scrollView._originuiccOpenClone,
    );
    const visible =
      targetFrame.y + targetFrame.height > viewportFrame.y &&
      targetFrame.y < viewportFrame.y + viewportFrame.height;

    iconActor.visible = visible;
    return visible;
  }

  _getSourceFrameOffset(sourceFrame, relativeTo, targetFrame) {
    const [relativeX, relativeY] = relativeTo.get_transformed_position();
    const sourceCenterX = sourceFrame.x - relativeX + sourceFrame.width / 2;
    const sourceCenterY = sourceFrame.y - relativeY + sourceFrame.height / 2;

    return {
      x: sourceCenterX - targetFrame.x - targetFrame.width / 2,
      y: sourceCenterY - targetFrame.y - targetFrame.height / 2,
    };
  }

  _getFrameScale(sourceFrame, iconActor) {
    const icon = iconActor.child ?? iconActor.get_child?.() ?? null;
    const iconWidth =
      icon?.allocation?.get_width?.() ||
      icon?.width ||
      OPEN_FOLDER_ICON_TEXTURE_SIZE;
    const iconHeight =
      icon?.allocation?.get_height?.() ||
      icon?.height ||
      OPEN_FOLDER_ICON_TEXTURE_SIZE;
    const scale = Math.min(
      sourceFrame.width / iconWidth,
      sourceFrame.height / iconHeight,
    );

    return Math.max(0.12, Math.min(1, scale));
  }

  _isActorOrDescendant(actor, parent) {
    for (let current = actor; current; current = current.get_parent?.()) {
      if (current === parent) return true;
    }

    return false;
  }

  _syncNavigation() {
    const hasMultiplePages = this._pages.length > 1;

    this._prevButton.visible = hasMultiplePages && this._currentPage > 0;
    this._nextButton.visible =
      hasMultiplePages && this._currentPage < this._pages.length - 1;

    this._pageIndicators.destroy_all_children();
    this._pageIndicators.set_size(
      hasMultiplePages
        ? this._pages.length * ARRANGED_PAGE_INDICATOR_DOT_SIZE +
            Math.max(0, this._pages.length - 1) *
              ARRANGED_PAGE_INDICATOR_DOT_SPACING
        : 1,
      ARRANGED_PAGE_INDICATOR_DOT_SIZE,
    );

    if (!hasMultiplePages) {
      this._syncShellPositions();
      return;
    }

    for (let i = 0; i < this._pages.length; i++) {
      const dot = new St.Button({
        style_class: "originuicc-arranged-page-dot",
        reactive: true,
      });

      if (i === this._currentPage) dot.add_style_pseudo_class("checked");

      dot.connect("clicked", () => this.goToPage(i));
      this._pageIndicators.add_child(dot);
    }

    this._syncShellPositions();
  }
}

export class OverviewRemake {
  enable() {
    this._wallpaperManagers = [];
    this._wallpaperLayer = null;
    this._monitorSignalId = 0;
    this._searchEntryBinSetupId = 0;
    this._appLibrarySetupId = 0;
    this._arrangedRebuildId = 0;
    this._appDisplayState = null;
    this._appSystemSignalIds = [];
    this._settingsSignalIds = [];
    this._appGridAnimator = new OriginAppGridAnimator(() =>
      this._shouldRunAppGridOverviewAnimation(),
    );

    this._themeContext = St.ThemeContext.get_for_stage(global.stage);
    this._scaleFactorSignalId = this._themeContext.connect(
      "notify::scale-factor",
      () => this._updateOverviewWallpaperEffects(),
    );

    this._colorSettings = St.Settings.get();
    this._colorSchemeSignalId = this._colorSettings.connect(
      "notify::color-scheme",
      () => this._syncColorScheme(),
    );

    this._createOverviewWallpaper();
    this._bindOverviewWallpaperSignals();
    this._setupSearchEntryBinClass();
    this._setupAppLibrarySwitcher();
    this._appGridAnimator.enable();
    this._syncColorScheme();
  }

  disable() {
    if (this._searchEntryBinSetupId) {
      GLib.source_remove(this._searchEntryBinSetupId);
      this._searchEntryBinSetupId = 0;
    }

    if (this._appLibrarySetupId) {
      GLib.source_remove(this._appLibrarySetupId);
      this._appLibrarySetupId = 0;
    }

    if (this._arrangedRebuildId) {
      GLib.source_remove(this._arrangedRebuildId);
      this._arrangedRebuildId = 0;
    }

    this._appGridAnimator?.disable();
    this._appGridAnimator = null;
    this._disconnectAppSignals();
    this._destroyAppLibrarySwitcher();
    this._clearSearchEntryBinClass();
    this._unbindOverviewWallpaperSignals();
    this._destroyOverviewWallpaper();

    if (this._colorSchemeSignalId && this._colorSettings) {
      this._colorSettings.disconnect(this._colorSchemeSignalId);
      this._colorSchemeSignalId = 0;
    }

    if (this._scaleFactorSignalId && this._themeContext) {
      this._themeContext.disconnect(this._scaleFactorSignalId);
      this._scaleFactorSignalId = 0;
    }

    this._clearColorScheme();
    this._themeContext = null;
    this._colorSettings = null;
  }

  _syncColorScheme() {
    const actor = Main.layoutManager?.overviewGroup;

    if (!actor) return;

    actor.remove_style_class_name("originuicc-light");
    actor.remove_style_class_name("originuicc-dark");
    actor.add_style_class_name(this._getColorSchemeClass());
  }

  _clearColorScheme() {
    const actor = Main.layoutManager?.overviewGroup;

    if (!actor) return;

    actor.remove_style_class_name("originuicc-light");
    actor.remove_style_class_name("originuicc-dark");
  }

  _getColorSchemeClass() {
    try {
      const variant = Main.getStyleVariant?.();

      if (variant === "dark") return "originuicc-dark";
      if (variant === "light") return "originuicc-light";
    } catch (_) {}

    return this._colorSettings?.colorScheme === St.SystemColorScheme.PREFER_DARK
      ? "originuicc-dark"
      : "originuicc-light";
  }

  _bindOverviewWallpaperSignals() {
    this._monitorSignalId = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        this._createOverviewWallpaper();
      },
    );
  }

  _unbindOverviewWallpaperSignals() {
    if (this._monitorSignalId) {
      Main.layoutManager.disconnect(this._monitorSignalId);
      this._monitorSignalId = 0;
    }
  }

  _createOverviewWallpaper() {
    this._clearWallpaperManagers();

    if (!this._wallpaperLayer) {
      this._wallpaperLayer = new Clutter.Actor({
        reactive: false,
        name: "originuicc-overview-wallpaper-layer",
      });

      Main.layoutManager.overviewGroup.insert_child_at_index(
        this._wallpaperLayer,
        0,
      );
    }

    this._wallpaperLayer.destroy_all_children();

    for (const [monitorIndex, monitor] of Main.layoutManager.monitors.entries())
      this._addMonitorWallpaper(monitorIndex, monitor);

    this._updateOverviewWallpaperEffects();
  }

  _addMonitorWallpaper(monitorIndex, monitor) {
    const wallpaperActor = new St.Widget({
      style_class: "originuicc-overview-wallpaper",
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
      clip_to_allocation: true,
      reactive: false,
      effect: new Shell.BlurEffect({
        name: OVERVIEW_BACKGROUND_BLUR_EFFECT,
      }),
    });

    this._wallpaperLayer.add_child(wallpaperActor);
    this._wallpaperManagers.push(
      new Background.BackgroundManager({
        container: wallpaperActor,
        monitorIndex,
        controlPosition: false,
      }),
    );
  }

  _updateOverviewWallpaperEffects() {
    if (!this._wallpaperLayer) return;

    const scaleFactor = this._themeContext?.scale_factor ?? 1;

    for (const wallpaperActor of this._wallpaperLayer) {
      const effect = wallpaperActor.get_effect(OVERVIEW_BACKGROUND_BLUR_EFFECT);

      effect?.set({
        brightness: OVERVIEW_BACKGROUND_BLUR_BRIGHTNESS,
        radius: OVERVIEW_BACKGROUND_BLUR_RADIUS * scaleFactor,
      });
    }
  }

  _clearWallpaperManagers() {
    for (const manager of this._wallpaperManagers) manager.destroy();

    this._wallpaperManagers = [];
  }

  _destroyOverviewWallpaper() {
    this._clearWallpaperManagers();

    if (this._wallpaperLayer) {
      this._wallpaperLayer.destroy();
      this._wallpaperLayer = null;
    }
  }

  _setupSearchEntryBinClass() {
    this._syncSearchEntryBinClass();

    this._searchEntryBinSetupId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1000,
      () => {
        this._syncSearchEntryBinClass();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _getSearchEntryBin() {
    return Main.overview?._overview?.controls?._searchEntryBin ?? null;
  }

  _syncSearchEntryBinClass() {
    this._getSearchEntryBin()?.add_style_class_name(
      "originuicc-search-entry-bin",
    );
  }

  _clearSearchEntryBinClass() {
    this._getSearchEntryBin()?.remove_style_class_name(
      "originuicc-search-entry-bin",
    );
  }

  _setupAppLibrarySwitcher() {
    this._syncAppLibrarySwitcher();
    this._connectAppSignals();

    this._appLibrarySetupId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1000,
      () => {
        this._syncAppLibrarySwitcher();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _getAppDisplay() {
    return Main.overview?._overview?.controls?._appDisplay ?? null;
  }

  _syncAppLibrarySwitcher() {
    const appDisplay = this._getAppDisplay();

    if (!appDisplay?._box || !appDisplay?._grid || !appDisplay?._pageIndicators)
      return;

    if (this._appDisplayState?.appDisplay === appDisplay) return;

    this._destroyAppLibrarySwitcher();

    const children = appDisplay._box.get_children();
    const scrollContainer = children[0] ?? null;

    if (!scrollContainer) return;

    const arrangedGrid = new OriginArrangedAppGrid();
    const switcher = new OriginSegmentedControl("All", "Arranged", (index) => {
      this._setAppLibraryTab(index);
    });

    appDisplay.add_style_class_name("originuicc-app-library-enabled");
    appDisplay._box.insert_child_at_index(arrangedGrid.actor, 1);
    appDisplay._box.add_child(switcher.actor);

    this._appDisplayState = {
      appDisplay,
      scrollContainer,
      pageIndicators: appDisplay._pageIndicators,
      arrangedGrid,
      switcher,
      activeTab: APP_LIBRARY_TAB_ALL,
      visibleTab: APP_LIBRARY_TAB_ALL,
      tabTransitionId: 0,
      tabTransitionTimeouts: new Set(),
    };

    this._rebuildArrangedGrid();
    this._setAppLibraryTab(APP_LIBRARY_TAB_ALL, false);
  }

  _destroyAppLibrarySwitcher() {
    const state = this._appDisplayState;

    if (!state) return;

    try {
      state.scrollContainer.visible = true;
      state.pageIndicators.visible = true;
      state.appDisplay.remove_style_class_name(
        "originuicc-app-library-enabled",
      );
    } catch (_) {}

    try {
      state.arrangedGrid.destroy();
      state.switcher.destroy();
    } catch (_) {}

    this._appDisplayState = null;
  }

  _setAppLibraryTab(tabIndex, animate = true) {
    const state = this._appDisplayState;
    if (!state) return;
    if (
      state.activeTab === tabIndex &&
      state.visibleTab === tabIndex &&
      animate
    )
      return;

    this._appGridAnimator?.cancel?.(true);
    this._cancelTabTransition(state);

    const arranged = tabIndex === APP_LIBRARY_TAB_ARRANGED;
    const oldTab = state.visibleTab ?? state.activeTab;
    const oldActor =
      oldTab === APP_LIBRARY_TAB_ARRANGED
        ? state.arrangedGrid.actor
        : state.scrollContainer;
    const newActor = arranged
      ? state.arrangedGrid.actor
      : state.scrollContainer;

    state.activeTab = tabIndex;
    state.switcher.setActive(tabIndex, animate);
    state.pageIndicators.visible = false;

    if (arranged) this._rebuildArrangedGrid();

    if (oldTab === tabIndex) {
      const otherActor = arranged
        ? state.scrollContainer
        : state.arrangedGrid.actor;

      oldActor.visible = true;
      otherActor.visible = false;
      this._resetTabItems(APP_LIBRARY_TAB_ALL, 255, true);
      this._resetTabItems(APP_LIBRARY_TAB_ARRANGED, 255, true);
      state.pageIndicators.visible = !arranged;
      state.visibleTab = tabIndex;
      state.arrangedGrid._suspendPageActorSync = false;
      return;
    }

    if (!animate) {
      oldActor.visible = false;
      newActor.visible = true;
      this._resetTabItems(oldTab, 255);
      this._resetTabItems(tabIndex, 255);
      state.pageIndicators.visible = !arranged;
      state.visibleTab = tabIndex;
      state.arrangedGrid._suspendPageActorSync = false;
      return;
    }

    const transitionId = ++state.tabTransitionId;
    const outItems = this._getTabAnimationItems(oldTab);
    const finishSwitch = () => {
      if (!this._isCurrentTabTransition(state, transitionId)) return;

      if (arranged) state.arrangedGrid._suspendPageActorSync = true;

      oldActor.visible = false;
      newActor.opacity = 0;
      newActor.visible = true;
      state.visibleTab = tabIndex;
      state.pageIndicators.visible = !arranged;
      this._forceTabActorLayout(newActor);
      this._queueTabReveal(state, transitionId, tabIndex, newActor);
    };

    try {
      this._animateTabItems(outItems, false, finishSwitch);
    } catch (error) {
      logError(error, "OriginUICC tab transition failed");
      oldActor.visible = false;
      newActor.visible = true;
      state.visibleTab = tabIndex;
      state.pageIndicators.visible = !arranged;
      if (arranged) state.arrangedGrid._suspendPageActorSync = false;
      this._resetTabItems(tabIndex, 255, true);
    }
  }

  _isCurrentTabTransition(state, transitionId) {
    return (
      this._appDisplayState === state && state.tabTransitionId === transitionId
    );
  }

  _cancelTabTransition(state) {
    state.tabTransitionId++;

    for (const id of state.tabTransitionTimeouts ?? []) {
      try {
        GLib.source_remove(id);
      } catch (_) {}
    }

    state.tabTransitionTimeouts?.clear?.();
    if (state.arrangedGrid) state.arrangedGrid._suspendPageActorSync = false;
    if (state.scrollContainer) state.scrollContainer.opacity = 255;
    if (state.arrangedGrid?.actor) state.arrangedGrid.actor.opacity = 255;
    this._resetTabItems(APP_LIBRARY_TAB_ALL, 255, true);
    this._resetTabItems(APP_LIBRARY_TAB_ARRANGED, 255, true);
  }

  _forceTabActorLayout(actor) {
    try {
      actor?.queue_relayout?.();
      actor?.queue_redraw?.();
      actor?.get_parent?.()?.queue_relayout?.();
      global.stage?.queue_redraw?.();
    } catch (_) {}
  }

  _queueTabReveal(state, transitionId, tabIndex, newActor, attempt = 0) {
    let revealId = 0;
    revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      state.tabTransitionTimeouts?.delete?.(revealId);

      if (this._isCurrentTabTransition(state, transitionId)) {
        this._forceTabActorLayout(newActor);
        this._revealTabFromCenter(
          state,
          transitionId,
          tabIndex,
          newActor,
          attempt,
        );
      }

      return GLib.SOURCE_REMOVE;
    });
    state.tabTransitionTimeouts?.add?.(revealId);
  }

  _revealTabFromCenter(state, transitionId, tabIndex, newActor, attempt = 0) {
    const arranged = tabIndex === APP_LIBRARY_TAB_ARRANGED;

    try {
      this._prepareTabActorForAnimation(tabIndex);

      const inItems = this._getTabAnimationItems(tabIndex, true);
      const inData = this._getTabItemsAnimationData(inItems, true);

      if (
        arranged &&
        attempt < 2 &&
        inData.length > 1 &&
        !this._hasTabItemMotion(inData)
      ) {
        this._queueTabReveal(
          state,
          transitionId,
          tabIndex,
          newActor,
          attempt + 1,
        );
        return;
      }

      this._setTabItemsInitialState(inData, true);
      this._setTabContainerInitialState(tabIndex);
      newActor.opacity = 255;
      this._animateTabContainerReveal(tabIndex);

      this._animateTabItemsFromData(
        inData,
        true,
        () => {
          if (!this._isCurrentTabTransition(state, transitionId)) return;
          if (arranged) {
            state.arrangedGrid._suspendPageActorSync = false;
            state.arrangedGrid._syncPageActors?.(false);
          }
          newActor.opacity = 255;
          this._resetTabItems(tabIndex, 255);
        },
        true,
      );
    } catch (error) {
      logError(error, "OriginUICC tab reveal failed");
      if (arranged) state.arrangedGrid._suspendPageActorSync = false;
      newActor.opacity = 255;
      this._resetTabItems(tabIndex, 255, true);
    }
  }

  _hasTabItemMotion(data) {
    return data.some(
      ({ delay, translationX, translationY }) =>
        delay > 0 ||
        Math.abs(translationX) > 0.5 ||
        Math.abs(translationY) > 0.5,
    );
  }

  _shouldRunAppGridOverviewAnimation() {
    const state = this._appDisplayState;

    if (!state) return true;

    return (
      state.activeTab === APP_LIBRARY_TAB_ALL &&
      state.visibleTab === APP_LIBRARY_TAB_ALL
    );
  }

  _getTabAnimationItems(tabIndex, includeHidden = false) {
    const state = this._appDisplayState;
    if (!state) return [];

    if (tabIndex === APP_LIBRARY_TAB_ARRANGED) {
      const pageActor =
        state.arrangedGrid._pageActors?.[state.arrangedGrid._currentPage ?? 0];

      return (pageActor?.get_children?.() ?? [])
        .flatMap((row) => row.get_children?.() ?? [])
        .flatMap((actor) => this._getArrangedFolderAnimationActors(actor))
        .filter(
          (actor) =>
            !actor.is_destroyed?.() && (includeHidden || actor.visible),
        );
    }

    const grid = state.appDisplay?._grid;
    const page = grid?.currentPage ?? 0;

    return (grid?.getItemsAtPage?.(page) ?? []).filter(
      (actor) => !actor.is_destroyed?.() && (includeHidden || actor.visible),
    );
  }

  _getArrangedFolderAnimationActors(folderActor) {
    const children = folderActor?.get_children?.() ?? [];
    const preview = children.find((actor) => actor._previewCells);

    if (!preview) return [];

    return [folderActor];
  }

  _prepareTabActorForAnimation(tabIndex) {
    const state = this._appDisplayState;
    if (!state) return;

    if (tabIndex === APP_LIBRARY_TAB_ARRANGED) {
      state.arrangedGrid._syncPageActors?.(false);

      const pageActor =
        state.arrangedGrid._pageActors?.[state.arrangedGrid._currentPage ?? 0];

      if (pageActor) {
        pageActor.visible = true;
        pageActor.opacity = 255;
        pageActor.scale_x = 1;
        pageActor.scale_y = 1;
      }
    }
  }

  _getCurrentArrangedPageActor() {
    const state = this._appDisplayState;

    return (
      state?.arrangedGrid?._pageActors?.[
        state.arrangedGrid._currentPage ?? 0
      ] ?? null
    );
  }

  _setTabContainerInitialState(tabIndex) {
    if (tabIndex !== APP_LIBRARY_TAB_ARRANGED) return;

    const pageActor = this._getCurrentArrangedPageActor();
    if (!pageActor) return;

    _cancelActorEase(pageActor);
    pageActor.remove_all_transitions?.();
    pageActor.set_pivot_point?.(0.5, 0.5);
    pageActor.opacity = 0;
    pageActor.scale_x = 0.94;
    pageActor.scale_y = 0.94;
  }

  _animateTabContainerReveal(tabIndex) {
    if (tabIndex !== APP_LIBRARY_TAB_ARRANGED) return;

    const pageActor = this._getCurrentArrangedPageActor();
    if (!pageActor) return;

    _easeActor(
      pageActor,
      {
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
      },
      {
        duration: TAB_SWITCH_ANIMATION_DURATION,
        cubic: TAB_SWITCH_SHOW_CUBIC,
      },
    );
  }

  _getTabItemsAnimationData(items, showing) {
    if (!items.length) return [];

    const frames = items.map((actor) => ({
      actor,
      frame: this._getActorStageFrame(actor),
    }));
    const minX = Math.min(...frames.map(({ frame }) => frame.x));
    const maxX = Math.max(...frames.map(({ frame }) => frame.x + frame.width));
    const minY = Math.min(...frames.map(({ frame }) => frame.y));
    const maxY = Math.max(...frames.map(({ frame }) => frame.y + frame.height));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const radiusX = Math.max((maxX - minX) / 2, 1);
    const radiusY = Math.max((maxY - minY) / 2, 1);
    let maxDistance = 1;

    const data = frames.map(({ actor, frame }) => {
      const itemCenterX = frame.x + frame.width / 2;
      const itemCenterY = frame.y + frame.height / 2;
      const normalizedX = (itemCenterX - centerX) / radiusX;
      const normalizedY = (itemCenterY - centerY) / radiusY;
      const distance = Math.hypot(normalizedX, normalizedY);
      const translationX = 0.7 * (centerX - itemCenterX);
      const translationY = 0.7 * (centerY - itemCenterY);

      maxDistance = Math.max(maxDistance, distance);
      return { actor, distance, translationX, translationY };
    });

    return data.map((item) => ({
      ...item,
      delay: Math.round(
        showing
          ? (item.distance / maxDistance) * TAB_SWITCH_ANIMATION_DELAY_RATIO
          : (item.distance / maxDistance) *
              (TAB_SWITCH_ANIMATION_DELAY_RATIO / 4),
      ),
    }));
  }

  _setTabItemsInitialState(data, showing) {
    for (const { actor, translationX, translationY } of data) {
      _cancelActorEase(actor);
      actor.remove_all_transitions?.();
      actor.set_pivot_point?.(0.5, 0.5);
      actor.visible = true;

      if (showing) {
        actor.opacity = 0;
        actor.scale_x = 0.3;
        actor.scale_y = 0.3;
        actor.translation_x = translationX;
        actor.translation_y = translationY;
      } else {
        actor.opacity = 255;
        actor.scale_x = 1;
        actor.scale_y = 1;
        actor.translation_x = 0;
        actor.translation_y = 0;
      }
    }
  }

  _animateTabItems(items, showing, onComplete) {
    this._animateTabItemsFromData(
      this._getTabItemsAnimationData(items, showing),
      showing,
      onComplete,
    );
  }

  _animateTabItemsFromData(
    data,
    showing,
    onComplete,
    initialAlreadySet = false,
  ) {
    const state = this._appDisplayState;
    if (!state) return;

    let pending = data.length;

    if (!pending) {
      onComplete?.();
      return;
    }

    let completed = false;
    const complete = () => {
      if (completed) return;

      completed = true;
      onComplete?.();
    };

    if (!initialAlreadySet) this._setTabItemsInitialState(data, showing);

    for (const { actor, delay, translationX, translationY } of data) {
      _easeActor(
        actor,
        showing
          ? {
              opacity: 255,
              scale_x: 1,
              scale_y: 1,
              translation_x: 0,
              translation_y: 0,
            }
          : {
              opacity: 0,
              scale_x: 0.3,
              scale_y: 0.3,
              translation_x: translationX,
              translation_y: translationY,
            },
        {
          delay,
          duration: TAB_SWITCH_ANIMATION_DURATION + delay,
          cubic: showing ? TAB_SWITCH_SHOW_CUBIC : TAB_SWITCH_HIDE_CUBIC,
          onComplete: () => {
            if (completed) return;
            pending--;
            if (pending === 0) complete();
          },
        },
      );
    }
  }

  _prepareTabItemsForIn(items) {
    for (const actor of items) {
      actor.visible = true;
      actor.opacity = 0;
      actor.scale_x = 0;
      actor.scale_y = 0;
    }
  }

  _resetTabItems(tabIndex, opacity = 255, includeHidden = false) {
    for (const actor of this._getTabAnimationItems(tabIndex, includeHidden)) {
      _cancelActorEase(actor);
      actor.remove_all_transitions?.();
      actor.visible = true;
      actor.opacity = opacity;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.translation_x = 0;
      actor.translation_y = 0;
    }
  }

  _getActorStageFrame(actor) {
    if (!actor || actor.is_destroyed?.())
      return { x: 0, y: 0, width: 1, height: 1 };

    let x = 0;
    let y = 0;

    try {
      [x, y] = actor.get_transformed_position();
    } catch (_) {
      [x, y] = [actor.x ?? 0, actor.y ?? 0];
    }

    const width = actor.allocation?.get_width?.() || actor.width || 1;
    const height = actor.allocation?.get_height?.() || actor.height || 1;

    return { x, y, width, height };
  }

  _connectAppSignals() {
    const appSystem = Shell.AppSystem.get_default();

    this._appSystemSignalIds.push(
      appSystem.connect("installed-changed", () =>
        this._queueArrangedGridRebuild(),
      ),
    );

    this._settingsSignalIds.push(
      global.settings.connect("changed::favorite-apps", () =>
        this._queueArrangedGridRebuild(),
      ),
    );
    this._settingsSignalIds.push(
      global.settings.connect("changed::app-picker-layout", () =>
        this._queueArrangedGridRebuild(),
      ),
    );
  }

  _disconnectAppSignals() {
    const appSystem = Shell.AppSystem.get_default();

    for (const signalId of this._appSystemSignalIds) {
      try {
        appSystem.disconnect(signalId);
      } catch (_) {}
    }

    for (const signalId of this._settingsSignalIds) {
      try {
        global.settings.disconnect(signalId);
      } catch (_) {}
    }

    this._appSystemSignalIds = [];
    this._settingsSignalIds = [];
  }

  _queueArrangedGridRebuild() {
    if (this._arrangedRebuildId) GLib.source_remove(this._arrangedRebuildId);

    this._arrangedRebuildId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      ARRANGED_REBUILD_DELAY,
      () => {
        this._arrangedRebuildId = 0;
        this._rebuildArrangedGrid();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _rebuildArrangedGrid() {
    const state = this._appDisplayState;

    if (!state) return;

    state.arrangedGrid.rebuild(this._collectInstalledApps());
  }

  _collectInstalledApps() {
    const appSystem = Shell.AppSystem.get_default();

    return appSystem
      .get_installed()
      .map((appInfo) => {
        try {
          const id = appInfo.get_id();

          if (!appInfo.should_show?.()) return null;

          const app = appSystem.lookup_app(id);

          return app ? { app, appInfo } : null;
        } catch (_) {
          return null;
        }
      })
      .filter((record) => record !== null)
      .sort((a, b) => a.app.get_name().localeCompare(b.app.get_name()));
  }
}
