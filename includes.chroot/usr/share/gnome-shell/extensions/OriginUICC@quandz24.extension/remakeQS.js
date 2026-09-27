import GLib from "gi://GLib";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

export const delayRatio = 25; // delay += delayRatio for each visible row
export const animationDuration = 550;
export const animationCubicBezier = [0.23, 1.32, 0.2, 1];
export const startScale = 0.6;
export const startTranslateY = 70;
export const FRAME_INTERVAL = 1000 / 60;

export function _cubic(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

export function _cubicDerivative(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b);
}

export function _cubicBezierProgress(x1, y1, x2, y2, progress) {
  progress = Math.clamp(progress, 0, 1);

  let t = progress;
  for (let i = 0; i < 8; i++) {
    const x = _cubic(x1, x2, t) - progress;
    const dx = _cubicDerivative(x1, x2, t);

    if (Math.abs(x) < 0.000001 || Math.abs(dx) < 0.000001) break;
    t = Math.clamp(t - x / dx, 0, 1);
  }

  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 8; i++) {
    const x = _cubic(x1, x2, t);

    if (Math.abs(x - progress) < 0.000001) break;
    if (x < progress) lower = t;
    else upper = t;

    t = (lower + upper) / 2;
  }

  return _cubic(y1, y2, t);
}

export function restoreActor(actor) {
  if (!actor || actor.is_destroyed?.()) return;

  actor.remove_all_transitions?.();
  actor.opacity = 255;
  actor.scale_x = 1;
  actor.scale_y = 1;
  actor.translation_y = 0;
}

export function stopActorAnimation(
  actor,
  animationIds,
  animationTokens,
  restore = false,
) {
  const frameId = animationIds?.get(actor);

  if (frameId) GLib.source_remove(frameId);

  animationIds?.delete(actor);
  animationTokens?.delete?.(actor);

  if (restore) restoreActor(actor);
}

/**
 * Generic animation engine.
 *
 * @param {Clutter.Actor} actor   - The actor to animate.
 * @param {object}        start   - Start state: { translateX, translateY, scale, opacity, rotateX, rotateY, rotateZ }
 * @param {object}        end     - End state:   { translateX, translateY, scale, opacity, rotateX, rotateY, rotateZ }
 * @param {object}        options - Options:
 *    duration      {number}   ms, default animationDuration
 *    delay         {number}   ms, default 0
 *    animationIds  {Map}
 *    animationTokens {WeakMap}
 *    tokenSymbol   {Symbol}
 *    errorTag      {string}
 *    fill          {string}   "both" | "forwards" (informational)
 *    onStart       {Function} called once before animation starts
 *    onUpdate      {Function} called each frame with (actor, easedProgress)
 *    onFinish      {Function} called when animation completes
 */
export function animateActorOpen(actor, start = {}, end = {}, options = {}) {
  if (!actor || actor.is_destroyed?.()) return;

  const {
    duration = animationDuration,
    delay = 0,
    animationIds,
    animationTokens,
    tokenSymbol = Symbol("open-animation"),
    errorTag = "OriginUICC open animation failed",
    onStart,
    onUpdate,
    onFinish,
  } = options;

  stopActorAnimation(actor, animationIds, animationTokens, false);

  const token = tokenSymbol;
  animationTokens?.set(actor, token);

  actor.remove_all_transitions?.();
  actor.set_pivot_point?.(0.5, 0.5);

  // ── Per-property config parser ─────────────────────────────────────────
  // Each property in start/end can be a plain number OR an object:
  //   { value: <number>, delay: <ms>, cubicBezier: [x1,y1,x2,y2] }
  //   start.X.delay  → positive ms: property starts that many ms after global delay
  //   end.X.delay    → negative ms or "-5%": property finishes that amount earlier
  //   cubicBezier    → only honoured on start; overrides global bezier for this prop
  const _pp = (raw) => {
    if (raw == null) return { value: null, delay: 0, cubicBezier: null };
    if (typeof raw === "object" && !Array.isArray(raw))
      return {
        value: raw.value ?? null,
        delay: raw.delay ?? 0,
        cubicBezier: Array.isArray(raw.cubicBezier) ? raw.cubicBezier : null,
      };
    return { value: raw, delay: 0, cubicBezier: null };
  };

  const KEYS = [
    "translateX",
    "translateY",
    "scaleX",
    "scaleY",
    "opacity",
    "rotateX",
    "rotateY",
    "rotateZ",
  ];
  const sp = {};
  const ep = {};
  for (const k of KEYS) {
    sp[k] = _pp(start[k]);
    ep[k] = _pp(end[k]);
  }

  // ── Snapshot original actor state BEFORE snapping ─────────────────────
  const orig = {
    translateX: actor.translation_x ?? 0,
    translateY: actor.translation_y ?? 0,
    scaleX: actor.scale_x ?? 1,
    scaleY: actor.scale_y ?? 1,
    opacity: actor.opacity ?? 255,
    rotateX: actor.rotation_angle_x ?? 0,
    rotateY: actor.rotation_angle_y ?? 0,
    rotateZ: actor.rotation_angle_z ?? 0,
  };

  // ── Resolve start values (fallback: current actor state) ───────────────
  const s = {};
  for (const k of KEYS) s[k] = sp[k].value ?? orig[k];

  // ── Resolve end values ─────────────────────────────────────────────────
  // • end.X explicitly set         → use it
  // • end.X missing but start.X set → animate back to pre-animation orig value
  // • both missing                  → no animation for this property
  const e = {};
  for (const k of KEYS) {
    if (ep[k].value != null) e[k] = ep[k].value;
    else if (sp[k].value != null) e[k] = orig[k];
    else e[k] = s[k];
  }

  // ── Snap actor to start state ──────────────────────────────────────────
  actor.translation_x = s.translateX;
  actor.translation_y = s.translateY;
  actor.scale_x = s.scaleX;
  actor.scale_y = s.scaleY;
  actor.opacity = Math.clamp(Math.round(s.opacity), 0, 255);
  actor.rotation_angle_x = s.rotateX;
  actor.rotation_angle_y = s.rotateY;
  actor.rotation_angle_z = s.rotateZ;

  if (onStart) onStart(actor);

  const startTime = GLib.get_monotonic_time();
  const [x1, y1, x2, y2] = options.cubicBezier || animationCubicBezier;
  const dur = Math.max(1, duration);

  // ── Per-property eased progress ────────────────────────────────────────
  const _propEased = (k, elapsed) => {
    const propStartDelay = Math.max(0, sp[k].delay || 0);
    const active = elapsed - delay - propStartDelay;
    if (active <= 0) return 0;

    const rawEnd = ep[k].delay || 0;
    let endMs = 0;
    if (typeof rawEnd === "string" && rawEnd.endsWith("%")) {
      endMs = (-dur * Math.abs(parseFloat(rawEnd))) / 100;
    } else {
      endMs = Math.min(0, rawEnd);
    }

    const effectiveDur = Math.max(1, dur + endMs);
    const progress = Math.clamp(active / effectiveDur, 0, 1);

    const bez = sp[k].cubicBezier;
    if (bez && bez.length === 4)
      return _cubicBezierProgress(bez[0], bez[1], bez[2], bez[3], progress);
    return _cubicBezierProgress(x1, y1, x2, y2, progress);
  };

  // Total duration accounts for the slowest per-property start delay
  const maxPropDelay = Math.max(
    0,
    ...KEYS.map((k) => Math.max(0, sp[k].delay || 0)),
  );
  const totalDur = dur + maxPropDelay;

  const frameId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    FRAME_INTERVAL,
    () => {
      try {
        if (
          actor.is_destroyed?.() ||
          !actor.get_stage?.() ||
          animationTokens?.get(actor) !== token
        ) {
          animationIds?.delete(actor);
          return GLib.SOURCE_REMOVE;
        }

        const elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        const activeElapsed = elapsed - delay;
        if (activeElapsed < 0) return GLib.SOURCE_CONTINUE;

        const globalProgress = Math.clamp(activeElapsed / totalDur, 0, 1);

        actor.translation_x =
          s.translateX +
          (e.translateX - s.translateX) * _propEased("translateX", elapsed);
        actor.translation_y =
          s.translateY +
          (e.translateY - s.translateY) * _propEased("translateY", elapsed);
        const scaleXV =
          s.scaleX + (e.scaleX - s.scaleX) * _propEased("scaleX", elapsed);
        const scaleYV =
          s.scaleY + (e.scaleY - s.scaleY) * _propEased("scaleY", elapsed);
        actor.scale_x = scaleXV;
        actor.scale_y = scaleYV;
        actor.opacity = Math.clamp(
          Math.round(
            s.opacity +
              (e.opacity - s.opacity) * _propEased("opacity", elapsed),
          ),
          0,
          255,
        );
        actor.rotation_angle_x =
          s.rotateX + (e.rotateX - s.rotateX) * _propEased("rotateX", elapsed);
        actor.rotation_angle_y =
          s.rotateY + (e.rotateY - s.rotateY) * _propEased("rotateY", elapsed);
        actor.rotation_angle_z =
          s.rotateZ + (e.rotateZ - s.rotateZ) * _propEased("rotateZ", elapsed);

        if (onUpdate) onUpdate(actor, globalProgress);

        if (globalProgress < 1) return GLib.SOURCE_CONTINUE;

        // Snap to exact end state
        actor.translation_x = e.translateX;
        actor.translation_y = e.translateY;
        actor.scale_x = e.scaleX;
        actor.scale_y = e.scaleY;
        actor.opacity = Math.clamp(Math.round(e.opacity), 0, 255);
        actor.rotation_angle_x = e.rotateX;
        actor.rotation_angle_y = e.rotateY;
        actor.rotation_angle_z = e.rotateZ;

        if (onFinish) onFinish(actor);
        animationIds?.delete(actor);
        return GLib.SOURCE_REMOVE;
      } catch (err) {
        logError(err, errorTag);
        animationIds?.delete(actor);
        restoreActor(actor);
        return GLib.SOURCE_REMOVE;
      }
    },
  );

  animationIds?.set(actor, frameId);
}

export class QuickSettingsRemake {
  constructor(extension = null) {
    this._extension = extension;
  }

  enable() {
    this._quickSettingsMenus = new Map();
    this._setupId = 0;
    this._colorSchemeSignalId = 0;
    this._animationIds = new Map();
    this._animationTokens = new WeakMap();
    this._quickToggleMenuSignals = new Map();
    this._colorSettings = St.Settings.get();

    this._colorSchemeSignalId = this._colorSettings.connect(
      "notify::color-scheme",
      () => this._syncAllColorSchemes(),
    );

    this._setupQuickSettingsHook();

    this._setupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      this._setupQuickSettingsHook();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._setupId) {
      GLib.source_remove(this._setupId);
      this._setupId = 0;
    }

    for (const [menu, signalId] of this._quickSettingsMenus) {
      try {
        menu.disconnect(signalId);
      } catch (_) {}
    }

    for (const [quickToggleMenu, signalId] of this._quickToggleMenuSignals) {
      try {
        quickToggleMenu.disconnect(signalId);
      } catch (_) {}
    }
    this._quickToggleMenuSignals.clear();

    if (this._colorSchemeSignalId && this._colorSettings) {
      this._colorSettings.disconnect(this._colorSchemeSignalId);
      this._colorSchemeSignalId = 0;
    }

    this._clearAllColorSchemes();
    this._quickSettingsMenus.clear();
    this._stopAllAnimations(true);
    this._colorSettings = null;
  }

  _setupQuickSettingsHook() {
    const menus = this._getQuickSettingsMenus();

    for (const [menu, signalId] of this._quickSettingsMenus) {
      if (menus.has(menu)) continue;

      try {
        menu.disconnect(signalId);
      } catch (_) {}
      menu?._boxPointer?.remove_style_class_name(
        "originuicc-transparent-boxpointer",
      );
      this._disconnectQuickToggleMenuHooksForMenu(menu);
      this._quickSettingsMenus.delete(menu);
    }

    for (const menu of menus) {
      if (this._quickSettingsMenus.has(menu)) continue;

      const signalId = menu.connect("open-state-changed", (_menu, isOpen) => {
        if (isOpen) {
          this._animateQuickSettingsOpen(_menu);
        } else {
          this._stopAllAnimations(true);
        }
      });

      this._quickSettingsMenus.set(menu, signalId);
      this._syncColorScheme(menu);
    }

    for (const menu of menus) {
      this._setupQuickToggleMenuHooks(menu);
    }
  }

  _syncAllColorSchemes() {
    for (const menu of this._quickSettingsMenus.keys())
      this._syncColorScheme(menu);
  }

  _syncColorScheme(menu) {
    const schemeClass = this._getColorSchemeClass();
    const actors = [menu?.box, ...this._getQuickToggleMenuBoxes(menu)];

    menu?._boxPointer?.add_style_class_name(
      "originuicc-transparent-boxpointer",
    );

    for (const actor of actors) {
      if (!actor) continue;

      actor.remove_style_class_name("originuicc-light");
      actor.remove_style_class_name("originuicc-dark");
      actor.add_style_class_name(schemeClass);
    }
  }

  _clearAllColorSchemes() {
    for (const menu of this._quickSettingsMenus.keys()) {
      menu?._boxPointer?.remove_style_class_name(
        "originuicc-transparent-boxpointer",
      );

      const actors = [menu?.box, ...this._getQuickToggleMenuBoxes(menu)];

      for (const actor of actors) {
        if (!actor) continue;

        actor.remove_style_class_name("originuicc-light");
        actor.remove_style_class_name("originuicc-dark");
      }
    }
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

  _getQuickSettingsMenus() {
    const menus = new Set();
    const addPanel = (panel) => {
      const menu = panel?.statusArea?.quickSettings?.menu;
      if (menu) menus.add(menu);
    };

    addPanel(Main.panel);

    for (const panelData of global.dashToPanel?.panels ?? [])
      addPanel(panelData?.panel ?? panelData);

    return menus;
  }

  _setupQuickToggleMenuHooks(menu) {
    for (const quickToggleMenu of this._getQuickToggleMenus(menu)) {
      if (this._quickToggleMenuSignals.has(quickToggleMenu)) continue;

      const signalId = quickToggleMenu.connect("open-state-changed", () => {
        this._syncColorScheme(menu);
      });

      this._quickToggleMenuSignals.set(quickToggleMenu, signalId);
    }

    this._syncColorScheme(menu);
  }

  _disconnectQuickToggleMenuHooksForMenu(menu) {
    for (const quickToggleMenu of this._getQuickToggleMenus(menu)) {
      const signalId = this._quickToggleMenuSignals.get(quickToggleMenu);

      if (!signalId) continue;

      try {
        quickToggleMenu.disconnect(signalId);
      } catch (_) {}

      this._quickToggleMenuSignals.delete(quickToggleMenu);
    }
  }

  _getQuickToggleMenus(menu) {
    const grid = menu?._grid;

    if (!grid) return [];

    return grid
      .get_children()
      .map((actor) => actor?.menu)
      .filter((quickToggleMenu) => !!quickToggleMenu?.box);
  }

  _getQuickToggleMenuBoxes(menu) {
    return this._getQuickToggleMenus(menu).map(
      (quickToggleMenu) => quickToggleMenu.box,
    );
  }

  _animateQuickSettingsOpen(menu) {
    const grid = menu?._grid;

    if (!grid?.layout_manager) return;

    const rows = this._getGridRows(grid);
    // Flatten rows to a single list of actors for sequential animation
    const sections = rows.flat();

    sections.forEach((actor, index) => {
      this._animateItemOpen(actor, index * 30);
    });
  }

  _getGridRows(grid) {
    const layout = grid.layout_manager;
    const nColumns = Math.max(1, layout.nColumns ?? layout.n_columns ?? 1);
    const rows = [];
    let currentRow = [];
    let lineIndex = 0;

    const appendRow = () => {
      currentRow = [];
      rows.push(currentRow);
      lineIndex = 0;
    };

    for (const child of grid.get_children()) {
      if (!(child instanceof St.Widget) || !child.visible) continue;

      if (lineIndex === 0) appendRow();

      const colSpan = this._getColumnSpan(layout, grid, child, nColumns);
      const fitsRow = lineIndex + colSpan <= nColumns;

      if (!fitsRow) appendRow();

      currentRow.push(child);
      lineIndex = (lineIndex + colSpan) % nColumns;
    }

    return rows.filter((row) => row.length > 0);
  }

  _getColumnSpan(layout, grid, child, nColumns) {
    let colSpan = 1;

    try {
      const meta = layout.get_child_meta?.(grid, child);
      colSpan = meta?.columnSpan ?? meta?.column_span ?? 1;
    } catch (_) {
      colSpan = 1;
    }

    return Math.clamp(colSpan, 1, nColumns);
  }

  _animateItemOpen(actor, delay = 0, trsY = -35) {
    animateActorOpen(
      actor,
      { translateY: trsY, scaleX: startScale, scaleY: startScale, opacity: 0 },
      { translateY: 0, scaleX: 1, scaleY: 1, opacity: 255 },
      {
        duration: 550,
        delay,
        animationIds: this._animationIds,
        animationTokens: this._animationTokens,
        tokenSymbol: Symbol("datemenu-open-animation"),
        errorTag: "OriginUICC date menu animation failed",
        fill: "both",
      },
    );
  }

  _stopAnimation(actor, restore) {
    stopActorAnimation(
      actor,
      this._animationIds,
      this._animationTokens,
      restore,
    );
  }

  _stopAllAnimations(restore) {
    for (const [actor, frameId] of this._animationIds) {
      GLib.source_remove(frameId);
      if (restore) this._restoreActor(actor);
    }

    this._animationIds.clear();
    this._animationTokens = new WeakMap();
  }

  _restoreActor(actor) {
    restoreActor(actor);
  }
}
