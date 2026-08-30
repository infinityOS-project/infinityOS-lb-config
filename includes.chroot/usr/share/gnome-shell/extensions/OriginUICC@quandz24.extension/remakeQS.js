import GLib from "gi://GLib";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const delayRatio = 25; // delay += delayRatio for each visible row
const animationDuration = 550;
const animationCubicBezier = [0.23, 1.32, 0.2, 1];
const startScale = 0.6;
const startTranslateY = 70;
const FRAME_INTERVAL = 1000 / 60;

function _cubic(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

function _cubicDerivative(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b);
}

function _cubicBezierProgress(x1, y1, x2, y2, progress) {
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

    rows.forEach((row, rowIndex) => {
      const delay = rowIndex * delayRatio;
      row.forEach((actor) => this._animateItemOpen(actor, delay));
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

  _animateItemOpen(actor, delay) {
    if (!actor || actor.is_destroyed?.()) return;

    this._stopAnimation(actor, false);

    const token = Symbol("quick-settings-open-animation");
    this._animationTokens.set(actor, token);

    actor.remove_all_transitions?.();
    actor.set_pivot_point?.(0.5, 0.5);
    actor.opacity = 0;
    actor.scale_x = startScale;
    actor.scale_y = startScale;
    actor.translation_y = startTranslateY;

    const startTime = GLib.get_monotonic_time();
    const [x1, y1, x2, y2] = animationCubicBezier;
    const scaleDuration = Math.max(1, animationDuration);
    const opacityDuration = Math.max(1, animationDuration / 2);

    const frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        try {
          if (
            actor.is_destroyed?.() ||
            !actor.get_stage?.() ||
            this._animationTokens.get(actor) !== token
          ) {
            this._animationIds.delete(actor);
            return GLib.SOURCE_REMOVE;
          }

          const elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          const activeElapsed = elapsed - delay;

          if (activeElapsed < 0) return GLib.SOURCE_CONTINUE;

          const scaleLinear = Math.clamp(activeElapsed / scaleDuration, 0, 1);
          const opacityLinear = Math.clamp(
            activeElapsed / opacityDuration,
            0,
            1,
          );
          const scaleEased = _cubicBezierProgress(x1, y1, x2, y2, scaleLinear);
          const opacityEased = _cubicBezierProgress(
            x1,
            y1,
            x2,
            y2,
            opacityLinear,
          );

          actor.scale_x = startScale + (1 - startScale) * scaleEased;
          actor.scale_y = startScale + (1 - startScale) * scaleEased;
          actor.translation_y = startTranslateY * (1 - scaleEased);
          actor.opacity = Math.clamp(Math.round(255 * opacityEased), 0, 255);

          if (scaleLinear < 1 || opacityLinear < 1) return GLib.SOURCE_CONTINUE;

          actor.scale_x = 1;
          actor.scale_y = 1;
          actor.translation_y = 0;
          actor.opacity = 255;
          this._animationIds.delete(actor);
          return GLib.SOURCE_REMOVE;
        } catch (error) {
          logError(error, "OriginUICC quick settings animation failed");
          this._animationIds.delete(actor);
          this._restoreActor(actor);
          return GLib.SOURCE_REMOVE;
        }
      },
    );

    this._animationIds.set(actor, frameId);
  }

  _stopAnimation(actor, restore) {
    const frameId = this._animationIds.get(actor);

    if (frameId) GLib.source_remove(frameId);

    this._animationIds.delete(actor);
    this._animationTokens.delete?.(actor);

    if (restore) this._restoreActor(actor);
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
    if (!actor || actor.is_destroyed?.()) return;

    actor.remove_all_transitions?.();
    actor.opacity = 255;
    actor.scale_x = 1;
    actor.scale_y = 1;
    actor.translation_y = 0;
  }
}
