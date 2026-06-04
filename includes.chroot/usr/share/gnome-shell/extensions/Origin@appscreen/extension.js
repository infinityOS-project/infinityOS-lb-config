"use strict";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";
import Meta from "gi://Meta";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";

const other_duration = 150;
const other_cubic = [0.25, 0.1, 0.25, 1];

const FRAME_INTERVAL = 1000 / 60; // 60 fps

const stageOn_duration_minimize = 380;
const stageOn_duration_unminimize = 470;
const stageOn_cubic_minimize = [0.24, 0.86, 0.34, 0.98];
const stageOn_cubic_uminimize = [0.25, 1.2, 0.39, 1];
const stageOff_duration_minimize = 350;
const stageOff_duration_unminimize = 450;
const stageOff_cubic_minimize = [0.3, 0.6, 0.1, 1];
const stageOff_cubic_uminimize = [0.25, 1.2, 0.39, 1];
const DURATION_drag_out_unminimize = stageOn_duration_unminimize;
const drag_duration = 250;
const STAGE_CROSSFADE_DURATION = 50;

const DelayOpacity_minimize = 200; // only minimize
const OpacityDuration = 90; // for minimize and unminimize

//stage edge
const STAGE_EDGE_SIZE = 180;
const STAGE_LEFT_OFFSET = 18;
const STAGE_ROTATION_Y = 0;

const FALLBACK_ICON_SIZE = 48;
const STAGE_GAP = 15;
const STAGE_COVER_EXTRA = 20;
const STAGE_RESERVED_WIDTH =
  STAGE_LEFT_OFFSET + STAGE_EDGE_SIZE + STAGE_COVER_EXTRA;
const STAGE_SHADOW_PAD = 0;
const STAGE_SHADOW_STYLE =
  "border-radius: 22px;" + "box-shadow: rgba(0, 0, 0, 0.5) 0px 0px 25px -7px;";
const STAGE_ACTIVE_OPACITY = 204;
const STAGE_ACTIVE_DURATION = 200;
const STAGE_DRAG_THRESHOLD = 25;
const STAGE_HEIGHT_RATIO = 0.9;
const STAGE_MIN_SCROLL_SCALE = 0.5;
const STAGE_SCROLL_STEP = 90;
const WINDOW_KEEP_ONSCREEN_PADDING = 8;
const WINDOW_KEEP_ONSCREEN_DURATION = 400;
const STAGE_INFO_ICON_SIZE = 20;
const STAGE_INFO_GAP = 6;
const STAGE_INFO_TOP_MARGIN = 0;
const STAGE_INFO_ROW_HEIGHT = STAGE_INFO_TOP_MARGIN + STAGE_INFO_ICON_SIZE + 2;
const STAGE_INFO_LABEL_DURATION = 150;
const STAGE_INFO_LABEL_STYLE =
  "font-size: 15px;" +
  "font-weight: 600;" +
  "color: rgba(255, 255, 255, 0.94);" +
  "text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75);";
const STAGE_HOVER_SCALE = 1.1;

// for overview icon kiêm luôn transition mặc định.
const START_SCALE = 3;
const DURATION = 400;
const DELAY_RATIO = 330;
const CUBIC_BEZIER = [0.25, 1.25, 0.39, 1]; // for scale icon

const StageModeToggle = GObject.registerClass(
  class StageModeToggle extends QuickSettings.QuickToggle {
    constructor(owner) {
      super({
        title: "Centre stage",
        subtitle: "Off",
        iconName: "view-grid-symbolic",
        toggleMode: true,
      });

      this._owner = owner;
      this._clickedId = this.connect("clicked", () => {
        this._owner?._requestStageMode(this.checked);
      });
    }

    setStageState(enabled, queued) {
      let checked = queued ?? enabled;
      this.checked = checked;
      this.subtitle = checked ? "On" : "Off";
    }

    destroy() {
      if (this._clickedId) {
        this.disconnect(this._clickedId);
        this._clickedId = 0;
      }

      this._owner = null;
      super.destroy();
    }
  },
);

const StageModeIndicator = GObject.registerClass(
  class StageModeIndicator extends QuickSettings.SystemIndicator {
    constructor(owner) {
      super();

      this._indicator = this._addIndicator();
      this._indicator.icon_name = "view-grid-symbolic";
      this._indicator.visible = false;

      this._toggle = new StageModeToggle(owner);
      this.quickSettingsItems.push(this._toggle);
    }

    setStageState(enabled, queued) {
      let active = queued ?? enabled;
      this._indicator.visible = active;
      this._toggle.setStageState(enabled, queued);
    }

    destroy() {
      for (let item of this.quickSettingsItems) item.destroy();
      super.destroy();
    }
  },
);

function _cubic(a, b, t) {
  let inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

function _cubicDerivative(a, b, t) {
  let inv = 1 - t;
  return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b);
}

function _cubicBezierProgress(x1, y1, x2, y2, progress) {
  progress = Math.clamp(progress, 0, 1);

  let t = progress;
  for (let i = 0; i < 8; i++) {
    let x = _cubic(x1, x2, t) - progress;
    let dx = _cubicDerivative(x1, x2, t);

    if (Math.abs(x) < 0.000001 || Math.abs(dx) < 0.000001) break;
    t = Math.clamp(t - x / dx, 0, 1);
  }

  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 8; i++) {
    let x = _cubic(x1, x2, t);

    if (Math.abs(x - progress) < 0.000001) break;
    if (x < progress) lower = t;
    else upper = t;

    t = (lower + upper) / 2;
  }

  return _cubic(y1, y2, t);
}

function _nullCloneSources(actor) {
  try {
    if (actor instanceof Clutter.Clone) {
      try {
        actor.set_source(null);
      } catch {}
    }

    for (let child of actor.get_children?.() ?? []) _nullCloneSources(child);
  } catch {}
}

export default class OriginAppGrid {
  enable() {
    this._opened = false;
    this._timeoutIds = new Set();
    this._windowAnimationIds = new Map();
    this._windowActors = new Set();
    this._stageMode = false;
    this._stageEntries = new Map();
    this._stageOrder = [];
    this._stageSurfaceActors = new Set();
    this._pendingStageWindows = new Set();
    this._pendingRestoreTargets = new Map();
    this._pendingStageInsertIndexes = new Map();
    this._restoringWindows = new Set();
    this._actorAnimationTokens = new Map();
    this._stageIdleIds = new Set();
    this._restoringAllStageWindows = false;
    this._stageModeSwitchId = 0;
    this._monitorChangedSignal = 0;
    this._stageRestackedSignal = 0;
    this._stageReflowId = 0;
    this._stageStrutAdded = false;
    this._stagePointer = null;
    this._stageCaptureSignal = 0;
    this._stageGrab = null;
    this._stageGrabIsModal = false;
    this._stageHoverEntry = null;
    this._queuedStageMode = null;
    this._stageScrollOffset = 0;
    this._stageMaxScroll = 0;
    this._windowPushIds = new Map();
    this.heightStageCenter = 0;
    this._fitMode =
      Main.overview._overview.controls._workspacesDisplay._fitModeAdjustment;
    this._signal = this._fitMode.connect("notify::value", () => this._update());
    this._createStageToggle();
    this._ensureCoverLayer();
    this._ensureStageStrut();
    this._purgeOrphanStageSurfaces();
    this._connectWindowAnimations();
    this._connectStageStackSignals();
  }
  disable() {
    this._setStageMode(false);
    if (this._signal) {
      this._fitMode.disconnect(this._signal);
      this._signal = 0;
    }
    this._disconnectWindowAnimations();
    this._destroyStageStrut();
    this._destroyCoverLayer();
    this._destroyStageToggle();
    this._stopAllWindowAnimations();
    this._resetWindowActors();
    this._clearStageIdles();
    this._clearStageModeSwitch();
    this._disconnectMonitorChanged();
    this._disconnectStageStackSignals();
    this._clearStageReflow();
    this._clearStagePointer();
    this._clearWindowPushAnimations();
    this._clearTimeouts();
  }
  _update() {
    let progress = this._fitMode.value;
    if (progress > 0 && !this._opened) {
      this._opened = true;
      this._animate();
    } else if (progress < 1) {
      this._opened = false;
    }
  }
  _animate() {
    let appDisplay = Main.overview._overview.controls._appDisplay;

    if (!appDisplay?.mapped) return;
    this._clearTimeouts();

    let grid = appDisplay._grid;
    let layout = grid?.layoutManager ?? grid?.layout_manager;

    if (!grid?.mapped || !layout) return;

    let page = grid.currentPage ?? 0;
    let icons = grid.getItemsAtPage(page).filter((i) => i.visible);

    if (!icons.length) return;

    let pageWidth = layout.pageWidth ?? layout.page_width ?? grid.width;
    let pageHeight = layout.pageHeight ?? layout.page_height ?? grid.height;
    let cx = page * pageWidth + pageWidth / 2;
    let cy = pageHeight / 2;
    let max = 1;

    icons.forEach((i) => {
      i.remove_all_transitions();
      i.translation_x = 0;
      i.translation_y = 0;
      i.scale_x = 1;
      i.scale_y = 1;

      if (typeof i.set_pivot_point === "function") {
        i.set_pivot_point(0.5, 0.5);
      }

      let box = i.allocation;
      let ix = (box.x1 + box.x2) / 2;
      let iy = (box.y1 + box.y2) / 2;
      let d = Math.hypot(ix - cx, iy - cy);
      i._d = d;
      if (d > max) max = d;

      i.opacity = 0;
    });

    icons.forEach((i) => {
      let box = i.allocation;
      let ix = (box.x1 + box.x2) / 2;
      let iy = (box.y1 + box.y2) / 2;
      let dx = (ix - cx) * (START_SCALE - 1);
      let dy = (iy - cy) * (START_SCALE - 1);

      i.translation_x = dx;
      i.translation_y = dy;
      i.scale_x = START_SCALE;
      i.scale_y = START_SCALE;
      i.opacity = 0;

      this._easeIcon(i, dx, dy, START_SCALE, (i._d / max) * DELAY_RATIO);
    });
  }

  _clearTimeouts() {
    if (!this._timeoutIds) return;

    for (let id of this._timeoutIds) {
      GLib.Source.remove(id);
    }

    this._timeoutIds.clear();
  }

  _removeTimeout(id) {
    this._timeoutIds?.delete(id);
  }

  _addStageIdle(callback) {
    let id = 0;
    id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._stageIdleIds.delete(id);
      return callback();
    });
    this._stageIdleIds.add(id);
    return id;
  }

  _clearStageIdles() {
    for (let id of this._stageIdleIds ?? []) GLib.Source.remove(id);
    this._stageIdleIds?.clear();
  }

  _nextAnimationToken(actor) {
    if (!actor) return 0;

    let token = (this._actorAnimationTokens.get(actor) ?? 0) + 1;
    this._actorAnimationTokens.set(actor, token);
    return token;
  }

  _isCurrentAnimation(actor, token) {
    return this._actorAnimationTokens.get(actor) === token;
  }

  _setRotationY(actor, angle) {
    if (!actor) return;

    try {
      actor.rotation_angle_y = angle;
    } catch {
      try {
        actor.set_rotation_angle(Clutter.RotateAxis.Y_AXIS, angle);
      } catch {}
    }
  }

  _getRotationY(actor) {
    try {
      return actor.rotation_angle_y ?? 0;
    } catch {
      return 0;
    }
  }

  _setStageVisual(actor, enabled) {
    this._setRotationY(actor, 0);
  }

  _setStageMirrorPivot(entry) {
    let mirror = entry?.mirrorRotate;
    if (!mirror || mirror.is_destroyed?.()) return;

    let target = entry?.target;
    let monitor = Main.layoutManager.primaryMonitor;
    let pivotY = 0.5;
    if (target && monitor && target.height > 0) {
      let screenCenterY = monitor.y + monitor.height / 2;
      pivotY = (screenCenterY - target.y) / target.height;
    }

    if (typeof mirror.set_pivot_point === "function")
      mirror.set_pivot_point(0.5, pivotY);
  }

  _setStageMirrorVisual(entry, enabled, animate = false, duration = 180) {
    let mirror = entry?.mirrorRotate;
    if (!mirror || mirror.is_destroyed?.()) return;

    this._setStageMirrorPivot(entry);

    let rotationY = enabled ? STAGE_ROTATION_Y : 0;
    if (!animate) {
      this._setRotationY(mirror, rotationY);
      return;
    }

    this._animateActor(
      mirror,
      { rotationY },
      {
        duration,
        cubic: enabled ? stageOn_cubic_minimize : stageOn_cubic_uminimize,
      },
    );
  }

  _getStageArea(monitor = Main.layoutManager.primaryMonitor) {
    if (!monitor) return null;

    let height = Math.round(monitor.height * STAGE_HEIGHT_RATIO);
    return {
      x: monitor.x,
      y: monitor.y + Math.round((monitor.height - height) / 6),
      width: STAGE_RESERVED_WIDTH,
      height,
    };
  }

  _animateActor(actor, target, params = {}) {
    if (!actor || actor.is_destroyed?.()) return 0;

    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();

    let token = this._nextAnimationToken(actor);
    let duration = params.duration ?? stageOn_duration_minimize;
    let cubic = params.cubic ?? stageOn_cubic_minimize;
    let startTime = GLib.get_monotonic_time();
    let from = {
      x: actor.x ?? actor.get_x?.() ?? 0,
      y: actor.y ?? actor.get_y?.() ?? 0,
      scaleX: actor.scale_x ?? 1,
      scaleY: actor.scale_y ?? 1,
      opacity: actor.opacity ?? 255,
      rotationY: this._getRotationY(actor),
    };
    let to = {
      x: target.x ?? from.x,
      y: target.y ?? from.y,
      scaleX: target.scaleX ?? target.scale ?? from.scaleX,
      scaleY: target.scaleY ?? target.scale ?? from.scaleY,
      opacity: target.opacity ?? from.opacity,
      rotationY: target.rotationY ?? from.rotationY,
    };
    let opacityDelay = params.opacityDelay ?? 0;
    let opacityDuration = Math.max(1, params.opacityDuration ?? duration);

    let frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        try {
          if (
            !this._isCurrentAnimation(actor, token) ||
            actor.is_destroyed?.()
          ) {
            this._windowAnimationIds.delete(actor);
            return GLib.SOURCE_REMOVE;
          }

          let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          let linear = Math.clamp(elapsed / duration, 0, 1);
          let eased = _cubicBezierProgress(...cubic, linear);
          let opacityLinear = Math.clamp(
            (elapsed - opacityDelay) / opacityDuration,
            0,
            1,
          );
          let opacityEased = _cubicBezierProgress(...cubic, opacityLinear);

          let x = from.x + (to.x - from.x) * eased;
          let y = from.y + (to.y - from.y) * eased;
          if (actor.set_position) actor.set_position(x, y);
          else {
            actor.x = x;
            actor.y = y;
          }
          actor.scale_x = from.scaleX + (to.scaleX - from.scaleX) * eased;
          actor.scale_y = from.scaleY + (to.scaleY - from.scaleY) * eased;
          actor.opacity = Math.clamp(
            Math.round(
              from.opacity + (to.opacity - from.opacity) * opacityEased,
            ),
            0,
            255,
          );
          this._setRotationY(
            actor,
            from.rotationY + (to.rotationY - from.rotationY) * eased,
          );
          params.onUpdate?.(actor, eased);

          if (linear < 1) return GLib.SOURCE_CONTINUE;

          this._windowAnimationIds.delete(actor);
          if (actor.set_position) actor.set_position(to.x, to.y);
          else {
            actor.x = to.x;
            actor.y = to.y;
          }
          actor.scale_x = to.scaleX;
          actor.scale_y = to.scaleY;
          actor.opacity = Math.clamp(to.opacity, 0, 255);
          this._setRotationY(actor, to.rotationY);
          params.onUpdate?.(actor, 1);
          params.onComplete?.();
          return GLib.SOURCE_REMOVE;
        } catch {
          this._windowAnimationIds.delete(actor);
          return GLib.SOURCE_REMOVE;
        }
      },
    );

    this._windowAnimationIds.set(actor, frameId);
    return token;
  }

  _getActorPosition(actor) {
    return {
      x: actor?.x ?? actor?.get_x?.() ?? 0,
      y: actor?.y ?? actor?.get_y?.() ?? 0,
    };
  }

  _animateActorTransform(actor, target, params = {}) {
    if (!actor || actor.is_destroyed?.()) return 0;

    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();

    let token = this._nextAnimationToken(actor);
    let duration = params.duration ?? stageOn_duration_minimize;
    let cubic = params.cubic ?? stageOn_cubic_minimize;
    let startTime = GLib.get_monotonic_time();
    let from = {
      translationX: actor.translation_x ?? 0,
      translationY: actor.translation_y ?? 0,
      scaleX: actor.scale_x ?? 1,
      scaleY: actor.scale_y ?? 1,
      opacity: actor.opacity ?? 255,
      rotationY: this._getRotationY(actor),
    };
    let to = {
      translationX: target.translationX ?? from.translationX,
      translationY: target.translationY ?? from.translationY,
      scaleX: target.scaleX ?? target.scale ?? from.scaleX,
      scaleY: target.scaleY ?? target.scale ?? from.scaleY,
      opacity: target.opacity ?? from.opacity,
      rotationY: target.rotationY ?? from.rotationY,
    };
    let opacityDelay = params.opacityDelay ?? 0;
    let opacityDuration = Math.max(1, params.opacityDuration ?? duration);

    let frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        try {
          if (
            !this._isCurrentAnimation(actor, token) ||
            actor.is_destroyed?.() ||
            !actor.get_stage?.()
          ) {
            this._windowAnimationIds.delete(actor);
            return GLib.SOURCE_REMOVE;
          }

          let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          let linear = Math.clamp(elapsed / duration, 0, 1);
          let eased = _cubicBezierProgress(...cubic, linear);
          let opacityLinear = Math.clamp(
            (elapsed - opacityDelay) / opacityDuration,
            0,
            1,
          );
          let opacityEased = _cubicBezierProgress(...cubic, opacityLinear);

          actor.translation_x =
            from.translationX + (to.translationX - from.translationX) * eased;
          actor.translation_y =
            from.translationY + (to.translationY - from.translationY) * eased;
          actor.scale_x = from.scaleX + (to.scaleX - from.scaleX) * eased;
          actor.scale_y = from.scaleY + (to.scaleY - from.scaleY) * eased;
          actor.opacity = Math.clamp(
            Math.round(
              from.opacity + (to.opacity - from.opacity) * opacityEased,
            ),
            0,
            255,
          );
          this._setRotationY(
            actor,
            from.rotationY + (to.rotationY - from.rotationY) * eased,
          );
          params.onUpdate?.(actor, eased);

          if (linear < 1) return GLib.SOURCE_CONTINUE;

          this._windowAnimationIds.delete(actor);
          actor.translation_x = to.translationX;
          actor.translation_y = to.translationY;
          actor.scale_x = to.scaleX;
          actor.scale_y = to.scaleY;
          actor.opacity = Math.clamp(to.opacity, 0, 255);
          this._setRotationY(actor, to.rotationY);
          params.onUpdate?.(actor, 1);
          params.onComplete?.();
          return GLib.SOURCE_REMOVE;
        } catch {
          this._windowAnimationIds.delete(actor);
          return GLib.SOURCE_REMOVE;
        }
      },
    );

    this._windowAnimationIds.set(actor, frameId);
    return token;
  }

  _connectWindowAnimations() {
    if (this._minimizeSignal || this._unminimizeSignal) return;

    this._originalShouldAnimateActor = Main.wm._shouldAnimateActor;
    Main.wm._shouldAnimateActor = (actor, types) => {
      let stack = new Error().stack;
      if (
        this._shouldOwnWindowAnimation(actor) &&
        stack &&
        (stack.includes("_minimizeWindow") ||
          stack.includes("_unminimizeWindow"))
      ) {
        return false;
      }

      return this._originalShouldAnimateActor.call(Main.wm, actor, types);
    };

    this._originalCompletedMinimize = Main.wm._shellwm.completed_minimize;
    Main.wm._shellwm.completed_minimize = (actor) => {
      if (this._shouldOwnWindowAnimation(actor)) return;
      this._originalCompletedMinimize.call(Main.wm._shellwm, actor);
    };

    this._originalCompletedUnminimize = Main.wm._shellwm.completed_unminimize;
    Main.wm._shellwm.completed_unminimize = (actor) => {
      if (this._shouldOwnWindowAnimation(actor)) return;
      this._originalCompletedUnminimize.call(Main.wm._shellwm, actor);
    };

    this._minimizeSignal = global.window_manager.connect(
      "minimize",
      (wm, actor) => {
        if (Main.overview.visible) {
          if (this._shouldOwnWindowAnimation(actor))
            this._completeMinimize(actor);
          return;
        }

        if (this._stageMode) {
          if (!this._isStageActor(actor)) {
            this._completeMinimize(actor);
            return;
          }

          this._stageMinimizeActor(actor);
          return;
        }

        if (!this._isIconAnimationActor(actor)) return;

        this._animateWindowToIcon(actor, false);
      },
    );

    this._unminimizeSignal = global.window_manager.connect(
      "unminimize",
      (wm, actor) => {
        actor.show();

        if (!this._shouldOwnWindowAnimation(actor)) return;
        let metaWindow = actor.meta_window ?? actor.get_meta_window?.();

        if (Main.overview.visible) {
          if (this._stageEntries.has(actor)) this._unstageActor(actor);
          this._pendingRestoreTargets.delete(metaWindow);
          this._restoringWindows.delete(metaWindow);
          this._completeUnminimize(actor);
          return;
        }

        let hasStageFlow =
          this._stageEntries.has(actor) ||
          this._pendingStageWindows.has(metaWindow) ||
          this._pendingRestoreTargets.has(metaWindow) ||
          this._restoringWindows.has(metaWindow);

        if (hasStageFlow) {
          this._handleStageUnminimize(actor);
          return;
        }

        if (this._stageMode) {
          if (!this._isStageActor(actor)) {
            this._completeUnminimize(actor);
            return;
          }

          this._handleStageUnminimize(actor);
          return;
        }

        if (!this._isIconAnimationActor(actor)) {
          this._completeUnminimize(actor);
          return;
        }

        this._animateWindowToIcon(actor, true);
      },
    );

    this._mapSignal = global.window_manager.connect("map", (wm, actor) => {
      if (!this._stageMode || !this._isStageActor(actor)) return;

      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      this._minimizeVisibleWindowsExcept(metaWindow);
    });
  }

  _disconnectWindowAnimations() {
    if (this._minimizeSignal) {
      global.window_manager.disconnect(this._minimizeSignal);
      this._minimizeSignal = 0;
    }

    if (this._unminimizeSignal) {
      global.window_manager.disconnect(this._unminimizeSignal);
      this._unminimizeSignal = 0;
    }

    if (this._mapSignal) {
      global.window_manager.disconnect(this._mapSignal);
      this._mapSignal = 0;
    }

    if (this._originalShouldAnimateActor) {
      Main.wm._shouldAnimateActor = this._originalShouldAnimateActor;
      this._originalShouldAnimateActor = null;
    }

    if (this._originalCompletedMinimize) {
      Main.wm._shellwm.completed_minimize = this._originalCompletedMinimize;
      this._originalCompletedMinimize = null;
    }

    if (this._originalCompletedUnminimize) {
      Main.wm._shellwm.completed_unminimize = this._originalCompletedUnminimize;
      this._originalCompletedUnminimize = null;
    }
  }

  _completeMinimize(actor) {
    this._originalCompletedMinimize?.call(Main.wm._shellwm, actor);
  }

  _completeUnminimize(actor) {
    this._originalCompletedUnminimize?.call(Main.wm._shellwm, actor);
  }

  _isIconAnimationActor(actor) {
    let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    if (!metaWindow) return false;
    if (metaWindow.is_override_redirect?.()) return false;

    return [
      Meta.WindowType.NORMAL,
      Meta.WindowType.MODAL_DIALOG,
      Meta.WindowType.DIALOG,
    ].includes(metaWindow.windowType);
  }

  _shouldOwnWindowAnimation(actor) {
    let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    return (
      this._isIconAnimationActor(actor) ||
      this._stageMode ||
      this._stageEntries?.has(actor) ||
      this._pendingStageWindows?.has(metaWindow) ||
      this._pendingRestoreTargets?.has(metaWindow) ||
      this._restoringWindows?.has(metaWindow)
    );
  }

  _getWindowIcon(actor) {
    let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    if (!metaWindow) return null;

    let [success, icon] = metaWindow.get_icon_geometry();
    if (success) return this._normalizeIcon(icon, actor);

    let monitor = Main.layoutManager.monitors[metaWindow.get_monitor()];
    if (!monitor || !Main.overview.dash) return this._fallbackIcon(actor);

    Main.overview.dash._redisplay?.();

    let pid = metaWindow.get_pid();
    if (pid && Main.overview.dash._box) {
      for (let dashElement of Main.overview.dash._box.get_children()) {
        let app = dashElement.child?._delegate?.app;
        let pids = app?.get_pids?.();
        if (!pids?.includes(pid)) continue;

        let [x, y] = dashElement.get_transformed_position();
        let [width, height] = dashElement.get_transformed_size?.() ?? [
          dashElement.width,
          dashElement.height,
        ];
        return this._normalizeIcon({ x, y, width, height }, actor);
      }
    }

    return this._fallbackIcon(actor);
  }

  _fallbackIcon(actor) {
    let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    let monitor =
      Main.layoutManager.monitors[metaWindow?.get_monitor?.()] ??
      Main.layoutManager.primaryMonitor;

    return this._normalizeIcon(
      {
        x: monitor.x + monitor.width / 2 - FALLBACK_ICON_SIZE / 2,
        y: monitor.y + monitor.height - FALLBACK_ICON_SIZE,
        width: FALLBACK_ICON_SIZE,
        height: FALLBACK_ICON_SIZE,
      },
      actor,
    );
  }

  _normalizeIcon(icon, actor) {
    let [windowWidth, windowHeight] = actor.get_size();
    if (windowWidth <= 0 || windowHeight <= 0) return null;

    let width = icon.width > 0 ? icon.width : FALLBACK_ICON_SIZE;
    let height = icon.height > 0 ? icon.height : FALLBACK_ICON_SIZE;

    return {
      x: icon.x + (icon.width - width) / 2,
      y: icon.y + (icon.height - height) / 2,
      width: Math.min(width, windowWidth),
      height: Math.min(height, windowHeight),
    };
  }

  _isIdentityWindowTransform(actor) {
    return (
      Math.abs(actor.translation_x ?? 0) < 0.5 &&
      Math.abs(actor.translation_y ?? 0) < 0.5 &&
      Math.abs((actor.scale_x ?? 1) - 1) < 0.01 &&
      Math.abs((actor.scale_y ?? 1) - 1) < 0.01
    );
  }

  _animateWindowToIcon(actor, reverse) {
    if (!actor) return;

    let icon = this._getWindowIcon(actor);
    if (!icon) {
      if (reverse) this._completeUnminimize(actor);
      else this._completeMinimize(actor);
      return;
    }

    this._stopWindowAnimation(actor);
    this._windowActors.add(actor);
    if (!actor._stageDestroySignal) {
      actor._stageDestroySignal = actor.connect("destroy", () => {
        this._destroyWindowActor(actor);
      });
    }

    actor.remove_all_transitions?.();
    actor.show();

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    let [windowWidth, windowHeight] = actor.get_size();
    if (windowWidth <= 0 || windowHeight <= 0) {
      if (reverse) this._completeUnminimize(actor);
      else this._completeMinimize(actor);
      return;
    }

    let { x: windowX, y: windowY } = this._getActorPosition(actor);
    let targetScaleX = icon.width / windowWidth;
    let targetScaleY = icon.height / windowHeight;
    let targetTranslationX = icon.x - windowX;
    let targetTranslationY = icon.y - windowY;

    if (reverse && this._isIdentityWindowTransform(actor)) {
      actor.translation_x = targetTranslationX;
      actor.translation_y = targetTranslationY;
      actor.scale_x = targetScaleX;
      actor.scale_y = targetScaleY;
      actor.opacity = 0;
    } else if (!reverse) {
      actor.opacity = actor.opacity ?? 255;
    }

    this._setStageVisual(actor, false);

    this._animateActorTransform(
      actor,
      {
        translationX: reverse ? 0 : targetTranslationX,
        translationY: reverse ? 0 : targetTranslationY,
        scaleX: reverse ? 1 : targetScaleX,
        scaleY: reverse ? 1 : targetScaleY,
        opacity: reverse ? 255 : 0,
        rotationY: 0,
      },
      {
        duration: reverse
          ? stageOff_duration_unminimize
          : stageOff_duration_minimize,
        cubic: reverse ? stageOff_cubic_uminimize : stageOff_cubic_minimize,
        opacityDelay: reverse ? 0 : DelayOpacity_minimize,
        opacityDuration: OpacityDuration,
        onComplete: () => {
          if (reverse) {
            this._resetWindowActor(actor);
            this._completeUnminimize(actor);
            return;
          }

          this._completeMinimize(actor);
          actor.opacity = 0;
        },
      },
    );
  }

  _stopWindowAnimation(actor) {
    let frameId = this._windowAnimationIds?.get(actor);
    if (frameId) {
      GLib.Source.remove(frameId);
      this._windowAnimationIds.delete(actor);
    }
    this._nextAnimationToken(actor);
    actor?.remove_all_transitions?.();
  }

  _stopAllWindowAnimations() {
    for (let frameId of this._windowAnimationIds?.values?.() ?? [])
      GLib.Source.remove(frameId);

    this._windowAnimationIds?.clear();
    this._actorAnimationTokens?.clear();
  }

  _resetWindowActor(actor) {
    if (!actor) return;

    let entry = this._stageEntries?.get(actor);
    if (entry) this._destroyStageSurfaces(entry);

    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.scale_x = 1;
    actor.scale_y = 1;
    actor.opacity = 255;
    this._setStageVisual(actor, false);

    if (typeof actor.set_pivot_point === "function") {
      actor.set_pivot_point(0, 0);
    }

    try {
      if (actor._stageDestroySignal) {
        actor.disconnect(actor._stageDestroySignal);
        actor._stageDestroySignal = 0;
      }
    } catch {}

    this._windowActors?.delete(actor);
  }

  _resetWindowActors() {
    this._clearStageHover();

    for (let actor of this._windowActors ?? []) {
      this._resetWindowActor(actor);
    }

    this._stopAllWindowAnimations();
    this._windowActors?.clear();
    this._stageEntries?.clear();
    this._purgeOrphanStageSurfaces();
    this._stageSurfaceActors?.clear();
    this._stageOrder = [];
    this._pendingStageWindows?.clear();
    this._pendingRestoreTargets?.clear();
    this._pendingStageInsertIndexes?.clear();
    this._restoringWindows?.clear();
  }

  _destroyWindowActor(actor) {
    if (!actor) return;

    this._stopWindowAnimation(actor);

    actor.remove_all_transitions?.();

    this._windowActors?.delete(actor);

    this._windowAnimationIds?.delete(actor);

    actor._stageDestroySignal = 0;
  }

  _getActorVisualState(actor) {
    if (!actor || actor.is_destroyed?.()) return null;

    let { x, y } = this._getActorPosition(actor);
    return {
      x: x + (actor.translation_x ?? 0),
      y: y + (actor.translation_y ?? 0),
      scaleX: actor.scale_x ?? 1,
      scaleY: actor.scale_y ?? 1,
      opacity: actor.opacity ?? 255,
      rotationY: this._getRotationY(actor),
    };
  }

  _getStagePreviewSource(actor) {
    for (let child of actor?.get_children?.() ?? []) {
      let [width, height] = child.get_size?.() ?? [0, 0];
      if (width > 0 && height > 0) return child;
    }

    return actor;
  }

  _createStagePreviewActor(actor, width, height) {
    let source = this._getStagePreviewSource(actor);
    let preview = new Clutter.Clone({
      source,
      reactive: false,
      width,
      height,
    });
    preview.set_offscreen_redirect?.(Clutter.OffscreenRedirect.ALWAYS);
    preview.set_size?.(width, height);
    return preview;
  }

  _getStageWindowApp(metaWindow) {
    try {
      return Shell.WindowTracker.get_default().get_window_app(metaWindow);
    } catch {
      return null;
    }
  }

  _getStageWindowTitle(metaWindow) {
    let title = "";
    try {
      title = metaWindow?.get_title?.() ?? "";
    } catch {}

    if (title) return title;

    try {
      return this._getStageWindowApp(metaWindow)?.get_name?.() ?? "";
    } catch {
      return "";
    }
  }

  _createStageWindowIcon(metaWindow) {
    let app = this._getStageWindowApp(metaWindow);
    if (app) {
      try {
        let icon = app.create_icon_texture(STAGE_INFO_ICON_SIZE);
        icon.reactive = false;
        return icon;
      } catch {}
    }

    return new St.Icon({
      icon_name: "application-x-executable-symbolic",
      icon_size: STAGE_INFO_ICON_SIZE,
      reactive: false,
    });
  }

  _createStageSurfaces(entry, cloneState = null, shadowState = null) {
    if (entry.clone) return;

    let actor = entry.actor;
    let [width, height] = actor.get_size();
    cloneState ??= this._getActorVisualState(actor);
    let clone = this._createStagePreviewActor(actor, width, height);
    let shadow = new St.Widget({
      reactive: false,
      style: STAGE_SHADOW_STYLE,
      opacity: 0,
      clip_to_allocation: false,
    });

    shadow.set_position(cloneState?.x ?? actor.x, cloneState?.y ?? actor.y);
    shadow.set_scale(1, 1);
    shadow.opacity = shadowState?.opacity ?? 0;
    let mirror = new St.Widget({
      reactive: false,
      clip_to_allocation: false,
    });
    let mirrorRotate = new St.Widget({
      reactive: false,
      clip_to_allocation: false,
    });
    mirror.set_size(width, height);
    mirrorRotate.set_size(width, height);
    mirror.set_position(0, 0);
    mirrorRotate.set_position(0, 0);
    mirror.set_scale(cloneState?.scaleX ?? 1, cloneState?.scaleY ?? 1);
    mirror.opacity = cloneState?.opacity ?? 255;
    if (typeof mirror.set_pivot_point === "function")
      mirror.set_pivot_point(0, 0);
    if (typeof mirrorRotate.set_pivot_point === "function")
      mirrorRotate.set_pivot_point(0.5, 0.5);
    clone.set_position(0, 0);
    clone.set_scale(1, 1);
    clone.opacity = 255;
    if (typeof clone.set_pivot_point === "function")
      clone.set_pivot_point(0, 0);
    if (typeof shadow.set_pivot_point === "function")
      shadow.set_pivot_point(0, 0);
    clone._originStagePreview = true;
    clone._originStageEntry = entry;
    mirror._originStageMirror = true;
    mirror._originStageEntry = entry;
    mirrorRotate._originStageMirror = true;
    mirrorRotate._originStageEntry = entry;
    shadow._originStageSurface = true;
    shadow._originStageShadow = true;
    shadow._originStageRestoring = false;
    shadow._originStageEntry = entry;
    let infoRow = new St.Widget({
      reactive: false,
      clip_to_allocation: false,
    });
    let windowIcon = this._createStageWindowIcon(entry.metaWindow);
    let titleLabel = new St.Label({
      text: this._getStageWindowTitle(entry.metaWindow),
      reactive: false,
      opacity: 0,
      style: STAGE_INFO_LABEL_STYLE,
    });
    windowIcon._originStageSurfaceChild = true;
    titleLabel._originStageSurfaceChild = true;
    infoRow._originStageSurfaceChild = true;
    infoRow.add_child(windowIcon);
    infoRow.add_child(titleLabel);
    this._setRotationY(mirrorRotate, 0);
    if (shadowState) {
      shadow.set_position(shadowState.x, shadowState.y);
      shadow.set_scale(shadowState.scaleX ?? 1, shadowState.scaleY ?? 1);
      shadow.opacity = shadowState.opacity ?? 255;
      this._setRotationY(shadow, 0);
    }

    mirrorRotate.add_child(clone);
    mirror.add_child(mirrorRotate);
    shadow.add_child(mirror);
    shadow.add_child(infoRow);
    global.window_group.add_child(shadow);

    entry.clone = clone;
    entry.mirror = mirror;
    entry.mirrorRotate = mirrorRotate;
    entry.shadow = shadow;
    entry.infoRow = infoRow;
    entry.icon = windowIcon;
    entry.label = titleLabel;
    this._stageSurfaceActors.add(shadow);
    this._syncStageStack(entry);
  }

  _destroyStageSurfaceActor(actor, fade = false) {
    if (!actor) return;

    try {
      if (actor.is_destroyed?.()) {
        this._stageSurfaceActors?.delete(actor);
        return;
      }
    } catch {
      this._stageSurfaceActors?.delete(actor);
      return;
    }

    try {
      this._stopStageSurfaceAnimations(actor);
    } catch {}

    this._stageSurfaceActors?.delete(actor);

    let isShadow = false;
    try {
      isShadow = !!actor._originStageShadow;
    } catch {}

    try {
      actor._originStageSurface = false;
      actor._originStagePreview = false;
      actor._originStageShadow = false;
      actor._originStageRestoring = false;
      actor._originStageEntry = null;
    } catch {}

    let destroyActor = () => {
      _nullCloneSources(actor);
      try {
        actor.hide?.();
      } catch {}
      try {
        actor.get_parent?.()?.remove_child?.(actor);
      } catch {}
      try {
        actor.destroy();
      } catch {}
    };

    if (fade && isShadow) {
      try {
        actor.ease({
          opacity: 0,
          duration: STAGE_ACTIVE_DURATION,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onStopped: destroyActor,
        });
        return;
      } catch {}
    }

    destroyActor();
  }

  _stopStageSurfaceAnimations(actor) {
    if (!actor) return;

    try {
      this._stopWindowAnimation(actor);
    } catch {}

    try {
      actor.remove_all_transitions?.();
    } catch {}

    let children = [];
    try {
      children = actor.get_children?.() ?? [];
    } catch {}

    for (let child of children) this._stopStageSurfaceAnimations(child);
  }

  _destroyStageSurfaces(entry, fadeShadow = false) {
    if (entry === this._stageHoverEntry) this._clearStageHover();

    if (entry?.shadow) this._destroyStageSurfaceActor(entry.shadow, fadeShadow);
    else if (entry?.clone) this._destroyStageSurfaceActor(entry.clone);

    if (entry) {
      entry.clone = null;
      entry.mirror = null;
      entry.mirrorRotate = null;
      entry.shadow = null;
      entry.infoRow = null;
      entry.icon = null;
      entry.label = null;
    }
  }

  _replaceStageSurfaces(entry) {
    if (!entry?.shadow) return;

    let cloneState = this._getActorVisualState(entry.shadow);
    let shadowState = this._getActorVisualState(entry.shadow);

    this._destroyStageSurfaces(entry);
    this._createStageSurfaces(entry, cloneState, shadowState);
  }

  _purgeOrphanStageSurfaces() {
    let validActors = new Set();
    for (let entry of this._stageEntries?.values?.() ?? []) {
      if (entry.shadow) validActors.add(entry.shadow);
    }

    for (let actor of [...(this._stageSurfaceActors ?? [])]) {
      if (validActors.has(actor)) continue;
      this._destroyStageSurfaceActor(actor);
    }

    for (let actor of global.window_group.get_children()) {
      if (validActors.has(actor)) continue;

      let isMarkedSurface =
        actor._originStageSurface &&
        !actor._originStageRestoring &&
        (!actor._originStageEntry ||
          !this._stageEntries.has(actor._originStageEntry.actor));
      let isLegacyShadow =
        actor instanceof St.Widget &&
        !actor._originStageRestoring &&
        actor.style === STAGE_SHADOW_STYLE &&
        this._actorIntersectsStageEdge(actor);

      if (isMarkedSurface || isLegacyShadow)
        this._destroyStageSurfaceActor(actor);
    }
  }

  _actorIntersectsStageEdge(actor) {
    let area = this._getStageArea();
    if (!area || !actor?.get_transformed_position) return false;

    let [x, y] = actor.get_transformed_position();
    let [width, height] = actor.get_transformed_size?.() ?? [
      actor.width,
      actor.height,
    ];

    return (
      x < area.x + area.width &&
      x + width > area.x &&
      y < area.y + area.height &&
      y + height > area.y
    );
  }

  _syncStageStack(entry) {
    let parent = global.window_group;
    if (entry?.shadow) parent.set_child_above_sibling(entry.shadow, null);
    if (entry?.actor && entry?.shadow) {
      try {
        parent.set_child_below_sibling(entry.actor, entry.shadow);
      } catch {}
    }

    this._raiseStageStack();
  }

  _raiseStageStack() {
    if (!this._stageMode && !this._stagePointer) return;

    let parent = global.window_group;
    let raised = new Set();

    for (let actor of this._stageOrder ?? []) {
      let entry = this._stageEntries?.get(actor);
      if (!entry?.shadow || entry.shadow.is_destroyed?.()) continue;

      try {
        parent.set_child_above_sibling(entry.shadow, null);
        raised.add(entry.shadow);
      } catch {}

      if (entry.actor && !entry.actor.is_destroyed?.()) {
        try {
          parent.set_child_below_sibling(entry.actor, entry.shadow);
        } catch {}
      }
    }

    for (let actor of this._stageSurfaceActors ?? []) {
      if (!actor || actor.is_destroyed?.() || raised.has(actor)) continue;

      try {
        parent.set_child_above_sibling(actor, null);
      } catch {}
    }

    if (this._coverLayer?.visible) {
      try {
        parent.set_child_above_sibling(this._coverLayer, null);
      } catch {}
    }
  }

  _raiseWindowActor(actor) {
    if (!actor || actor.is_destroyed?.()) return;

    let parent = actor.get_parent?.() ?? global.window_group;
    try {
      parent.set_child_above_sibling(actor, null);
    } catch {}

    if (this._coverLayer) {
      try {
        global.window_group.set_child_above_sibling(this._coverLayer, null);
      } catch {}
    }
  }

  _syncStageSourceActor(entry, target, source = null) {
    let actor = entry?.actor;
    if (!actor || actor.is_destroyed?.() || !target || entry.state !== "staged")
      return;

    actor.remove_all_transitions?.();
    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    let { x, y } = this._getActorPosition(actor);
    let visualSource = source ?? entry.shadow;
    let sourceX = visualSource?.x ?? visualSource?.get_x?.() ?? target.x;
    let sourceY = visualSource?.y ?? visualSource?.get_y?.() ?? target.y;
    let sourceScale = visualSource?.scale_x ?? 1;
    actor.translation_x = sourceX + STAGE_SHADOW_PAD * sourceScale - x;
    actor.translation_y = sourceY + STAGE_SHADOW_PAD * sourceScale - y;
    actor.scale_x = target.scale * sourceScale;
    actor.scale_y = target.scale * (visualSource?.scale_y ?? sourceScale);
    actor.opacity = 255;
    this._setStageVisual(actor, true);
  }

  _hideStageSourceActor(entry) {
    let actor = entry?.actor;
    if (!actor || actor.is_destroyed?.()) return;

    try {
      actor.opacity = 0;
    } catch {}
  }

  _updateStageInfo(entry, target, shadowTarget) {
    let row = entry?.infoRow;
    if (!row || row.is_destroyed?.() || !target || !shadowTarget) return;

    let rowX = target.x - shadowTarget.x;
    let rowY =
      target.y - shadowTarget.y + target.height + STAGE_INFO_TOP_MARGIN;
    row.set_position(rowX, rowY);
    row.set_size(Math.max(1, target.width), STAGE_INFO_ICON_SIZE + 2);
    row.show?.();

    let icon = entry?.icon;
    if (icon && !icon.is_destroyed?.()) {
      icon.set_position(0, 0);
      icon.set_size?.(STAGE_INFO_ICON_SIZE, STAGE_INFO_ICON_SIZE);
      icon.show?.();
    }

    let label = entry?.label;
    if (label && !label.is_destroyed?.()) {
      label.text = this._getStageWindowTitle(entry.metaWindow);
      label.set_position(STAGE_INFO_ICON_SIZE + STAGE_INFO_GAP, 0);
      // label.set_width?.(
      //   Math.max(1, target.width - STAGE_INFO_ICON_SIZE - STAGE_INFO_GAP),
      // );
      label.set_width?.(
        Math.max(1, STAGE_EDGE_SIZE - STAGE_INFO_ICON_SIZE - STAGE_INFO_GAP),
      );
    }
  }

  _updateStageShadow(entry, target, animate) {
    let shadow = entry?.shadow;
    if (!shadow || !target) return;
    let preview = entry?.mirror;

    let shadowTarget = {
      x: target.x - STAGE_SHADOW_PAD,
      y: target.y - STAGE_SHADOW_PAD,
      scale: 1,
      opacity: 255,
      rotationY: 0,
    };
    shadow.set_size(
      target.width + STAGE_SHADOW_PAD * 2,
      target.height + STAGE_SHADOW_PAD * 2,
    );
    this._updateStageInfo(entry, target, shadowTarget);
    if (preview && !preview.is_destroyed?.()) {
      preview.set_position(
        target.x - shadowTarget.x,
        target.y - shadowTarget.y,
      );
      preview.set_scale(target.scale, target.scale);
      preview.opacity = 255;
      preview.show?.();
      entry.clone?.show?.();
      entry.mirrorRotate?.show?.();
      this._setStageMirrorVisual(entry, true, animate, STAGE_ACTIVE_DURATION);
    }

    if (animate) return;

    shadow.set_position(shadowTarget.x, shadowTarget.y);
    shadow.set_scale(shadowTarget.scale, shadowTarget.scale);
    this._setRotationY(shadow, shadowTarget.rotationY);
    this._syncStageSourceActor(entry, target, shadow);
    if ((shadow.opacity ?? 0) < shadowTarget.opacity) {
      shadow.ease({
        opacity: shadowTarget.opacity,
        duration: STAGE_ACTIVE_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } else {
      shadow.opacity = shadowTarget.opacity;
    }
  }

  _createStageToggle() {
    if (this._stageIndicator) return;

    this._stageIndicator = new StageModeIndicator(this);
    Main.panel.statusArea.quickSettings.addExternalIndicator(
      this._stageIndicator,
    );
    this._updateStageToggle();
  }

  _destroyStageToggle() {
    if (!this._stageIndicator) return;

    this._stageIndicator.destroy();
    this._stageIndicator = null;
  }

  _updateStageToggle() {
    this._stageIndicator?.setStageState(this._stageMode, this._queuedStageMode);
  }

  _ensureCoverLayer() {
    if (this._coverLayer) return;

    this._coverLayer = new St.Widget({
      reactive: true,
      visible: false,
    });
    this._coverLayerPressSignal = this._coverLayer.connect(
      "button-press-event",
      (cover, event) => this._onStageButtonPress(event),
    );
    this._coverLayerReleaseSignal = this._coverLayer.connect(
      "button-release-event",
      (cover, event) => {
        if (!this._stagePointer) return Clutter.EVENT_PROPAGATE;

        let [x, y] = event.get_coords();
        this._onStagePointerRelease(x, y, event);
        return Clutter.EVENT_STOP;
      },
    );
    this._coverLayerMotionSignal = this._coverLayer.connect(
      "motion-event",
      (cover, event) => {
        let [x, y] = event.get_coords();
        if (!this._stagePointer) {
          this._updateStageHover(x, y);
          return Clutter.EVENT_PROPAGATE;
        }

        this._onStagePointerMotion(x, y, event);
        return Clutter.EVENT_STOP;
      },
    );
    this._coverLayerLeaveSignal = this._coverLayer.connect(
      "leave-event",
      () => {
        if (!this._stagePointer) this._clearStageHover();
        return Clutter.EVENT_PROPAGATE;
      },
    );
    this._coverLayerScrollSignal = this._coverLayer.connect(
      "scroll-event",
      (cover, event) => this._onStageScroll(event),
    );
    global.window_group.add_child(this._coverLayer);
  }

  _destroyCoverLayer() {
    if (!this._coverLayer) return;

    this._clearStagePointer();
    this._clearStageHover();

    if (this._coverLayerPressSignal) {
      this._coverLayer.disconnect(this._coverLayerPressSignal);
      this._coverLayerPressSignal = 0;
    }

    if (this._coverLayerReleaseSignal) {
      this._coverLayer.disconnect(this._coverLayerReleaseSignal);
      this._coverLayerReleaseSignal = 0;
    }

    if (this._coverLayerMotionSignal) {
      this._coverLayer.disconnect(this._coverLayerMotionSignal);
      this._coverLayerMotionSignal = 0;
    }

    if (this._coverLayerLeaveSignal) {
      this._coverLayer.disconnect(this._coverLayerLeaveSignal);
      this._coverLayerLeaveSignal = 0;
    }

    if (this._coverLayerScrollSignal) {
      this._coverLayer.disconnect(this._coverLayerScrollSignal);
      this._coverLayerScrollSignal = 0;
    }

    this._coverLayer.destroy();
    this._coverLayer = null;
  }

  _connectMonitorChanged() {
    if (this._monitorChangedSignal) return;

    this._monitorChangedSignal = Main.layoutManager.connect(
      "monitors-changed",
      () => this._updateStageStrut(),
    );
  }

  _disconnectMonitorChanged() {
    if (!this._monitorChangedSignal) return;

    Main.layoutManager.disconnect(this._monitorChangedSignal);
    this._monitorChangedSignal = 0;
  }

  _connectStageStackSignals() {
    if (this._stageRestackedSignal) return;

    try {
      this._stageRestackedSignal = global.display.connect("restacked", () =>
        this._raiseStageStack(),
      );
    } catch {
      this._stageRestackedSignal = 0;
    }
  }

  _disconnectStageStackSignals() {
    if (!this._stageRestackedSignal) return;

    try {
      global.display.disconnect(this._stageRestackedSignal);
    } catch {}
    this._stageRestackedSignal = 0;
  }

  _ensureStageStrut() {
    if (this._stageStrut) return;

    this._stageStrut = new St.Widget({
      reactive: false,
      visible: false,
      opacity: 0,
      name: "origin-stage-reserved-area",
    });
    this._connectMonitorChanged();
  }

  _destroyStageStrut() {
    if (!this._stageStrut) return;

    if (this._stageStrutAdded) {
      Main.layoutManager.removeChrome(this._stageStrut);
      this._stageStrutAdded = false;
    }

    this._stageStrut.destroy();
    this._stageStrut = null;
  }

  _clearStageReflow() {
    if (!this._stageReflowId) return;

    GLib.Source.remove(this._stageReflowId);
    this._stageReflowId = 0;
  }

  _queueReflowMaximizedWindows() {
    this._clearStageReflow();

    this._stageReflowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      this._stageReflowId = 0;
      this._reflowMaximizedWindows();
      return GLib.SOURCE_REMOVE;
    });
  }

  _reflowMaximizedWindows() {
    let monitorIndex = Main.layoutManager.primaryIndex;

    for (let metaWindow of global.display.list_all_windows()) {
      if (!this._isStageWindow(metaWindow)) continue;
      if (metaWindow.get_monitor?.() !== monitorIndex) continue;
      if (metaWindow.minimized) continue;
      if (!metaWindow.can_maximize?.()) continue;
      if (metaWindow.get_maximized?.() !== Meta.MaximizeFlags.BOTH) continue;

      this._remaximizeWindow(metaWindow);
    }
  }

  _remaximizeWindow(metaWindow) {
    if (!metaWindow) return;
    if (metaWindow.get_monitor?.() !== Main.layoutManager.primaryIndex) return;
    if (!metaWindow.can_maximize?.()) return;
    if (metaWindow.get_maximized?.() !== Meta.MaximizeFlags.BOTH) return;

    metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    metaWindow.maximize(Meta.MaximizeFlags.BOTH);
  }

  _updateStageStrut() {
    if (!this._stageStrut) return;

    let monitor = Main.layoutManager.primaryMonitor;
    if (!this._stageMode || !monitor) {
      if (this._stageStrutAdded) {
        Main.layoutManager.removeChrome(this._stageStrut);
        this._stageStrutAdded = false;
      }

      this._stageStrut.hide();
      this._queueReflowMaximizedWindows();
      return;
    }

    if (!this._stageStrutAdded) {
      Main.layoutManager.addChrome(this._stageStrut, {
        affectsStruts: true,
        trackFullscreen: true,
      });
      this._stageStrutAdded = true;
    }

    let area = this._getStageArea(monitor);
    this._stageStrut.set_position(area.x, area.y);
    this._stageStrut.set_size(area.width, area.height);
    this._stageStrut.show();
    this._queueReflowMaximizedWindows();
  }

  _updateCoverLayer() {
    if (!this._coverLayer) return;

    if (this._stagePointer) {
      this._coverLayer.set_position(0, 0);
      this._coverLayer.set_size(global.stage.width, global.stage.height);
      this._coverLayer.show();
      this._raiseStageStack();
      return;
    }

    let area = this._getStageArea();
    if (!this._stageMode || !this._stageOrder.length || !area) {
      this._clearStageHover();
      this._coverLayer.hide();
      return;
    }

    this._coverLayer.set_position(area.x, area.y);
    this._coverLayer.set_size(area.width, area.height);
    this._coverLayer.show();
    this._raiseStageStack();
  }

  _isInStageEdge(x, y) {
    let area = this._getStageArea();
    if (!area) return false;

    return (
      x >= area.x &&
      x <= area.x + area.width &&
      y >= area.y &&
      y <= area.y + area.height
    );
  }

  _getStageEntryVisualTarget(entry) {
    if (!entry?.target) return null;

    if (entry.state === "minimizing") {
      let actor = entry.actor;
      if (!actor || actor.is_destroyed?.()) return null;

      let [width, height] = actor.get_size();
      let state = this._getActorVisualState(actor);
      let scale = Math.max(state?.scaleX ?? entry.target.scale ?? 1, 0.001);
      return {
        ...entry.target,
        x: state?.x ?? entry.target.x,
        y: state?.y ?? entry.target.y,
        width: width * scale,
        height: height * (state?.scaleY ?? scale),
        scale,
      };
    }

    return this._getCurrentStageTarget(entry) ?? entry.target;
  }

  _getStageEntryHitTargets(entry) {
    if (!entry?.target) return [];

    let targets = [];
    let addTarget = (target) => {
      if (!target) return;
      if (
        targets.some(
          (item) =>
            Math.abs(item.x - target.x) < 1 &&
            Math.abs(item.y - target.y) < 1 &&
            Math.abs(item.width - target.width) < 1 &&
            Math.abs(item.height - target.height) < 1,
        )
      )
        return;

      targets.push(target);
    };

    addTarget(this._getStageEntryVisualTarget(entry));
    if (entry.state === "minimizing") addTarget(entry.target);

    return targets;
  }

  _getStageEntryHit(entry, x, y) {
    for (let target of this._getStageEntryHitTargets(entry)) {
      if (
        x >= target.x &&
        x <= target.x + target.width &&
        y >= target.y &&
        y <= target.y + target.height
      ) {
        return { entry, target };
      }
    }

    return null;
  }

  _onStageScroll(event) {
    if (!this._stageMode || this._stageMaxScroll <= 0)
      return Clutter.EVENT_PROPAGATE;

    let direction = event.get_scroll_direction?.();
    let delta = 0;
    if (direction === Clutter.ScrollDirection.UP) delta = -STAGE_SCROLL_STEP;
    else if (direction === Clutter.ScrollDirection.DOWN)
      delta = STAGE_SCROLL_STEP;
    else if (direction === Clutter.ScrollDirection.SMOOTH) {
      let [, dy] = event.get_scroll_delta?.() ?? [0, 0];
      delta = dy * STAGE_SCROLL_STEP;
    }

    if (delta === 0) return Clutter.EVENT_STOP;

    this._stageScrollOffset = Math.clamp(
      this._stageScrollOffset + delta,
      0,
      this._stageMaxScroll,
    );
    this._relayoutStage(true, drag_duration);
    return Clutter.EVENT_STOP;
  }

  _getStageEntryAt(x, y) {
    if (!this._isInStageEdge(x, y)) return null;

    for (let i = this._stageOrder.length - 1; i >= 0; i--) {
      let entry = this._stageEntries.get(this._stageOrder[i]);
      if (entry?.state === "restoring") continue;

      let hit = this._getStageEntryHit(entry, x, y);
      if (hit) return hit.entry;
    }

    return null;
  }

  _setStageEntryActive(entry, active) {
    let actor = entry?.shadow ?? entry?.clone ?? entry?.actor;
    if (!actor || actor.is_destroyed?.()) return;

    actor.ease({
      opacity: active ? STAGE_ACTIVE_OPACITY : 255,
      duration: STAGE_ACTIVE_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _setStageEntryLabelVisible(entry, visible) {
    try {
      let label = entry?.label;
      if (label && !label.is_destroyed?.()) {
        label.remove_all_transitions?.();
        label.ease({
          opacity: visible ? 255 : 0,
          duration: STAGE_INFO_LABEL_DURATION,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      }

      let shadow = entry?.shadow;
      if (!shadow || shadow.is_destroyed?.()) return;

      if (typeof shadow.set_pivot_point === "function")
        shadow.set_pivot_point(0.5, 0.5);

      shadow.ease({
        scaleX: visible ? STAGE_HOVER_SCALE : 1,
        scaleY: visible ? STAGE_HOVER_SCALE : 1,
        duration: STAGE_INFO_LABEL_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } catch {}
  }

  _updateStageHover(x, y) {
    let entry = this._getStageEntryAt(x, y);
    if (entry === this._stageHoverEntry) return;

    this._setStageEntryLabelVisible(this._stageHoverEntry, false);
    this._stageHoverEntry = entry;
    this._setStageEntryLabelVisible(entry, true);
  }

  _clearStageHover() {
    this._setStageEntryLabelVisible(this._stageHoverEntry, false);
    this._stageHoverEntry = null;
  }

  _grabStagePointer() {
    if (this._stageCaptureSignal) return;

    this._updateCoverLayer();

    try {
      this._stageGrab = Main.pushModal(this._coverLayer ?? global.stage, {
        actionMode: Shell.ActionMode.NORMAL,
      });
      this._stageGrabIsModal = true;
    } catch {
      try {
        this._stageGrab = global.stage.grab(this._coverLayer ?? global.stage);
      } catch {
        this._stageGrab = null;
      }
      this._stageGrabIsModal = false;
    }

    this._stageCaptureSignal = global.stage.connect(
      "captured-event",
      (stage, event) => this._onStageCapturedEvent(event),
    );
  }

  _ungrabStagePointer() {
    if (this._stageGrab) {
      try {
        if (this._stageGrabIsModal) Main.popModal(this._stageGrab);
        else this._stageGrab.dismiss();
      } catch {
        try {
          this._stageGrab.dismiss();
        } catch {}
      }
      this._stageGrab = null;
      this._stageGrabIsModal = false;
    }

    if (this._stageCaptureSignal) {
      global.stage.disconnect(this._stageCaptureSignal);
      this._stageCaptureSignal = 0;
    }
  }

  _clearStagePointer() {
    if (this._stagePointer?.entry)
      this._setStageEntryActive(this._stagePointer.entry, false);

    this._clearDragMoveFrame(this._stagePointer);
    this._stagePointer = null;
    this._ungrabStagePointer();
    this._updateCoverLayer();
  }

  _onStageButtonPress(event) {
    if (event.get_button?.() !== Clutter.BUTTON_PRIMARY)
      return Clutter.EVENT_PROPAGATE;

    let [x, y] = event.get_coords();
    let hit = null;
    for (let i = this._stageOrder.length - 1; i >= 0; i--) {
      let entry = this._stageEntries.get(this._stageOrder[i]);
      if (entry?.state === "restoring") continue;

      hit = this._getStageEntryHit(entry, x, y);
      if (hit) break;
    }

    if (!hit) return Clutter.EVENT_STOP;

    let { entry, target } = hit;
    this._stagePointer = {
      entry,
      mode: "stage",
      dragging: false,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      localStageX: x - target.x,
      localStageY: y - target.y,
      localWindowX: Math.max(0, (x - target.x) / Math.max(target.scale, 0.001)),
      localWindowY: Math.max(0, (y - target.y) / Math.max(target.scale, 0.001)),
    };
    this._setStageEntryActive(entry, true);
    this._grabStagePointer();
    return Clutter.EVENT_STOP;
  }

  _onStageCapturedEvent(event) {
    if (!this._stagePointer) return Clutter.EVENT_PROPAGATE;

    let type = event.type();
    if (type === Clutter.EventType.MOTION) {
      let [x, y] = event.get_coords();
      this._onStagePointerMotion(x, y, event);
      return Clutter.EVENT_STOP;
    }

    if (type === Clutter.EventType.BUTTON_RELEASE) {
      let [x, y] = event.get_coords();
      this._onStagePointerRelease(x, y, event);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_STOP;
  }

  _onStagePointerMotion(x, y, event) {
    let drag = this._stagePointer;
    if (!drag) return;

    drag.lastX = x;
    drag.lastY = y;

    if (!drag.dragging) {
      let distance = Math.hypot(x - drag.startX, y - drag.startY);
      if (distance < STAGE_DRAG_THRESHOLD) return;
      drag.dragging = true;
    }

    if (drag.mode === "stage") {
      if (drag.entry?.state === "minimizing")
        this._prepareMinimizingEntryForDrag(drag, x, y);

      if (!this._isInStageEdge(x, y)) {
        this._startStageDragOut(drag, x, y);
        return;
      }

      this._moveDraggedStageEntry(drag, x, y);
      return;
    }

    if (drag.mode === "window") {
      if (this._isInStageEdge(x, y)) {
        this._stageDraggedWindow(drag, x, y);
        return;
      }

      this._moveDraggedWindow(drag, x, y);
      return;
    }

    if (
      drag.mode === "restore-pending" ||
      drag.mode === "restore-animating" ||
      drag.mode === "stage-pending"
    ) {
      drag.lastX = x;
      drag.lastY = y;
    }
  }

  _onStagePointerRelease(x, y, event) {
    let drag = this._stagePointer;
    if (!drag) return;

    drag.lastX = x;
    drag.lastY = y;
    drag.released = true;
    let activateAfterClear = null;

    if (!drag.dragging && drag.entry) {
      let entry = drag.entry;
      let releasedEntry = this._getStageEntryAt(x, y);
      this._setStageEntryActive(entry, false);
      this._clearStagePointer();
      if (releasedEntry === entry) this._restoreStageEntry(entry);
      return;
    }

    if (drag.mode === "restore-animating" || drag.mode === "restore-pending") {
      this._clearStagePointer();
      return;
    }

    if (drag.mode === "stage-pending") {
      drag.releaseAfterStage = true;
      return;
    }

    if (drag.mode === "window" && this._isInStageEdge(x, y)) {
      drag.releaseAfterStage = true;
      this._stageDraggedWindow(drag, x, y);
      return;
    }

    if (drag.mode === "window") {
      this._flushDraggedWindowMove(drag);
      this._ensureWindowInsideMonitor(drag.metaWindow, true);
      if (drag.activateOnRelease) activateAfterClear = drag.metaWindow;
    }

    if (drag.mode === "stage" && drag.entry)
      this._setStageEntryActive(drag.entry, false);

    let shouldRelayout = drag.mode === "stage";
    this._clearStagePointer();
    activateAfterClear?.activate?.(global.get_current_time());
    if (shouldRelayout) this._relayoutStage(true, drag_duration);
  }

  _isDraggingStageEntry(entry) {
    return (
      this._stagePointer?.mode === "stage" &&
      this._stagePointer?.entry === entry &&
      this._stagePointer?.dragging
    );
  }

  _prepareMinimizingEntryForDrag(drag, x, y) {
    let entry = drag?.entry;
    if (!entry || entry.state !== "minimizing") return;

    entry.target = this._getPointerStageTarget(drag, entry, x, y);
    this._stopWindowAnimation(entry.actor);
    this._finishStageMinimize(entry);
    drag.entry = entry;
    drag.actor = null;
    drag.metaWindow = null;
    this._setStageEntryActive(entry, true);
  }

  _moveDraggedStageEntry(drag, x, y) {
    let entry = drag.entry;
    let surface = entry?.shadow;
    if (!entry || !surface || surface.is_destroyed?.()) return;

    this._reorderStageEntryForY(entry, y);

    this._stopWindowAnimation(surface);
    let dragTarget = this._getPointerStageTarget(drag, entry, x, y);
    this._updateStageShadow(entry, dragTarget, false);
    surface.opacity = STAGE_ACTIVE_OPACITY;
  }

  _getPointerStageTarget(drag, entry, x = drag?.lastX, y = drag?.lastY) {
    let actor = entry?.actor ?? drag?.actor;
    let target = entry?.target;
    let geometry = actor ? this._getStageGeometry(actor) : null;
    let scale = target?.scale ?? geometry?.scale ?? 1;
    let width = target?.width ?? geometry?.width ?? 1;
    let height = target?.height ?? geometry?.height ?? 1;
    let localX = Number.isFinite(drag?.localWindowX)
      ? drag.localWindowX * scale
      : (drag?.localStageX ?? width / 2);
    let localY = Number.isFinite(drag?.localWindowY)
      ? drag.localWindowY * scale
      : (drag?.localStageY ?? height / 2);

    return {
      ...(target ?? {}),
      x: x - localX,
      y: y - localY,
      width,
      height,
      scale,
    };
  }

  _reorderStageEntryForY(entry, y) {
    let actor = entry?.actor;
    if (!actor) return;

    let currentOrder = this._stageOrder.filter((item) => item !== actor);
    let insertIndex = currentOrder.length;

    for (let i = 0; i < currentOrder.length; i++) {
      let otherEntry = this._stageEntries.get(currentOrder[i]);
      let target = otherEntry?.target;
      if (!target) continue;

      if (y < target.y + target.height / 2) {
        insertIndex = i;
        break;
      }
    }

    let nextOrder = [...currentOrder];
    nextOrder.splice(insertIndex, 0, actor);
    if (nextOrder.every((item, index) => item === this._stageOrder[index]))
      return;

    this._stageOrder = nextOrder;
    this._relayoutStage(true, drag_duration);
  }

  _startStageDragOut(drag, x, y) {
    if (!drag.entry || drag.mode !== "stage") return;

    drag.mode = "restore-pending";
    drag.lastX = x;
    drag.lastY = y;
    drag.restoreTarget = this._getPointerStageTarget(drag, drag.entry, x, y);
    this._setStageEntryActive(drag.entry, false);
    this._restoreStageEntry(drag.entry, {
      minimizeOthers: false,
      dragInfo: drag,
    });
  }

  _clearDragMoveFrame(drag) {
    if (!drag?.moveFrameId) return;

    GLib.Source.remove(drag.moveFrameId);
    drag.moveFrameId = 0;
  }

  _applyDraggedWindowMove(drag, x, y) {
    let metaWindow = drag?.metaWindow;
    if (!metaWindow || metaWindow.minimized) return;

    if (metaWindow.get_maximized?.() !== 0)
      metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

    metaWindow.move_frame(
      true,
      Math.round(x - drag.localWindowX),
      Math.round(y - drag.localWindowY),
    );
  }

  _flushDraggedWindowMove(drag) {
    if (!drag) return;

    this._clearDragMoveFrame(drag);
    this._applyDraggedWindowMove(
      drag,
      drag.pendingWindowX ?? drag.lastX,
      drag.pendingWindowY ?? drag.lastY,
    );
  }

  _stopWindowPushAnimation(metaWindow) {
    let frameId = this._windowPushIds?.get(metaWindow);
    if (!frameId) return;

    GLib.Source.remove(frameId);
    this._windowPushIds.delete(metaWindow);
  }

  _clearWindowPushAnimations() {
    for (let frameId of this._windowPushIds?.values?.() ?? [])
      GLib.Source.remove(frameId);

    this._windowPushIds?.clear();
  }

  _ensureWindowInsideMonitor(metaWindow, animate) {
    if (!metaWindow || metaWindow.minimized) return;

    let monitor =
      Main.layoutManager.monitors[metaWindow.get_monitor?.()] ??
      Main.layoutManager.primaryMonitor;
    let rect = metaWindow.get_frame_rect?.();
    if (!monitor || !rect) return;

    let maxX =
      monitor.x + monitor.width - rect.width - WINDOW_KEEP_ONSCREEN_PADDING;
    let maxY =
      monitor.y + monitor.height - rect.height - WINDOW_KEEP_ONSCREEN_PADDING;
    let targetX =
      rect.width >= monitor.width - WINDOW_KEEP_ONSCREEN_PADDING * 2
        ? monitor.x + WINDOW_KEEP_ONSCREEN_PADDING
        : Math.clamp(rect.x, monitor.x + WINDOW_KEEP_ONSCREEN_PADDING, maxX);
    let targetY =
      rect.height >= monitor.height - WINDOW_KEEP_ONSCREEN_PADDING * 2
        ? monitor.y + WINDOW_KEEP_ONSCREEN_PADDING
        : Math.clamp(rect.y, monitor.y + WINDOW_KEEP_ONSCREEN_PADDING, maxY);

    if (Math.abs(rect.x - targetX) < 1 && Math.abs(rect.y - targetY) < 1)
      return;

    this._stopWindowPushAnimation(metaWindow);

    if (!animate) {
      metaWindow.move_frame(true, Math.round(targetX), Math.round(targetY));
      return;
    }

    let startX = rect.x;
    let startY = rect.y;
    let startTime = GLib.get_monotonic_time();
    let frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        if (!metaWindow || metaWindow.minimized) {
          this._windowPushIds.delete(metaWindow);
          return GLib.SOURCE_REMOVE;
        }

        let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        let linear = Math.clamp(elapsed / WINDOW_KEEP_ONSCREEN_DURATION, 0, 1);
        let eased = _cubicBezierProgress(...CUBIC_BEZIER, linear);
        metaWindow.move_frame(
          true,
          Math.round(startX + (targetX - startX) * eased),
          Math.round(startY + (targetY - startY) * eased),
        );

        if (linear < 1) return GLib.SOURCE_CONTINUE;

        this._windowPushIds.delete(metaWindow);
        metaWindow.move_frame(true, Math.round(targetX), Math.round(targetY));
        return GLib.SOURCE_REMOVE;
      },
    );
    this._windowPushIds.set(metaWindow, frameId);
  }

  _moveDraggedWindow(drag, x, y) {
    if (!drag?.metaWindow || drag.metaWindow.minimized) return;

    this._stopWindowPushAnimation(drag.metaWindow);
    drag.pendingWindowX = x;
    drag.pendingWindowY = y;
    if (drag.moveFrameId) return;

    drag.moveFrameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        drag.moveFrameId = 0;
        if (this._stagePointer !== drag || drag.mode !== "window")
          return GLib.SOURCE_REMOVE;

        this._applyDraggedWindowMove(
          drag,
          drag.pendingWindowX ?? drag.lastX,
          drag.pendingWindowY ?? drag.lastY,
        );
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _stageDraggedWindow(drag, x, y) {
    let metaWindow = drag.metaWindow;
    if (!metaWindow || metaWindow.minimized || drag.mode !== "window") return;

    this._flushDraggedWindowMove(drag);
    drag.stageMinimizeStart = {
      x: x - drag.localWindowX,
      y: y - drag.localWindowY,
      scaleX: 1,
      scaleY: 1,
      opacity: 255,
      rotationY: 0,
    };
    drag.mode = "stage-pending";
    drag.lastX = x;
    drag.lastY = y;
    drag.restoreTarget = null;
    metaWindow.minimize();
  }

  _requestStageMode(enabled) {
    enabled = !!enabled;

    if (this._stageModeSwitchId) {
      this._queuedStageMode = enabled;
      this._updateStageToggle();
      return;
    }

    this._setStageMode(enabled);
  }

  _clearStageModeSwitch() {
    if (this._stageModeSwitchId) {
      GLib.Source.remove(this._stageModeSwitchId);
      this._stageModeSwitchId = 0;
    }

    this._queuedStageMode = null;
    this._updateStageToggle();
  }

  _lockStageModeSwitch(duration) {
    if (this._stageModeSwitchId) GLib.Source.remove(this._stageModeSwitchId);

    this._stageModeSwitchId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      duration,
      () => {
        this._stageModeSwitchId = 0;

        let queued = this._queuedStageMode;
        this._queuedStageMode = null;
        if (queued !== null && queued !== this._stageMode)
          this._setStageMode(queued);
        else this._updateStageToggle();

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _setStageMode(enabled) {
    if (this._stageMode === enabled) return;

    this._clearStageIdles();

    if (!enabled) {
      this._stageMode = false;
      this._stageScrollOffset = 0;
      this._stageMaxScroll = 0;
      this._updateStageToggle();
      this._updateStageStrut();
      this._restoringAllStageWindows = true;
      this._cancelPendingStageWindows(true);
      this._restoreAllStageWindows();
      this._restoringAllStageWindows = false;
      this._updateCoverLayer();
      this._lockStageModeSwitch(
        stageOn_duration_unminimize + OpacityDuration + 80,
      );
      return;
    }

    this._stageMode = true;
    this._stageScrollOffset = 0;
    this._stageMaxScroll = 0;
    this._updateStageToggle();
    this._updateStageStrut();
    this._reflowMaximizedWindows();
    this._stageAllWindows();
    this._updateCoverLayer();
    this._lockStageModeSwitch(stageOn_duration_minimize + OpacityDuration + 80);
  }

  _cancelPendingStageWindows(restore) {
    let pendingWindows = [...(this._pendingStageWindows ?? [])];
    this._pendingStageWindows?.clear();
    for (let metaWindow of pendingWindows)
      this._pendingStageInsertIndexes?.delete(metaWindow);

    if (!restore) return;

    for (let metaWindow of pendingWindows) {
      if (metaWindow?.minimized) metaWindow.unminimize();
    }
  }

  _stageAllWindows() {
    let seenWindows = new Set();
    for (let actor of this._getStageActorsByStack()) {
      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      if (!this._isStageWindow(metaWindow)) continue;
      seenWindows.add(metaWindow);

      if (metaWindow.minimized) {
        this._pendingStageWindows.add(metaWindow);
        metaWindow.unminimize();
      } else {
        this._remaximizeWindow(metaWindow);
        metaWindow.minimize();
      }
    }

    for (let metaWindow of global.display.list_all_windows()) {
      if (seenWindows.has(metaWindow)) continue;
      if (!this._isStageWindow(metaWindow) || !metaWindow.minimized) continue;

      this._pendingStageWindows.add(metaWindow);
      metaWindow.unminimize();
    }
  }

  _getStageActorsByStack() {
    return global.window_group
      .get_children()
      .filter((actor) => this._isStageActor(actor));
  }

  _restoreAllStageWindows() {
    let entries = this._stageOrder
      .map((actor) => this._stageEntries.get(actor))
      .filter(Boolean);

    for (let entry of entries)
      this._restoreStageEntry(entry, {
        activate: false,
        minimizeOthers: false,
      });

    for (let metaWindow of global.display.list_all_windows()) {
      if (!this._isStageWindow(metaWindow)) continue;
      if (!metaWindow.minimized) continue;
      if (entries.some((entry) => entry.metaWindow === metaWindow)) continue;

      metaWindow.unminimize();
    }

    this._updateCoverLayer();
  }

  _isStageActor(actor) {
    return this._isStageWindow(
      actor?.meta_window ?? actor?.get_meta_window?.(),
    );
  }

  _isStageWindow(metaWindow) {
    if (!metaWindow) return false;
    if (metaWindow.skip_taskbar) return false;
    if (metaWindow.windowType !== Meta.WindowType.NORMAL) return false;
    if (metaWindow.is_override_redirect?.()) return false;

    let workspace = metaWindow.get_workspace?.();
    let activeWorkspace = global.workspace_manager.get_active_workspace();
    return (
      metaWindow.is_on_all_workspaces?.() ||
      !workspace ||
      workspace === activeWorkspace
    );
  }

  _stageMinimizeActor(actor) {
    if (!actor) return;

    let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
    if (!metaWindow) {
      this._completeMinimize(actor);
      return;
    }

    if (this._restoringWindows.has(metaWindow)) {
      this._restoringWindows.delete(metaWindow);
      this._pendingRestoreTargets.delete(metaWindow);
      this._stopWindowAnimation(actor);
    }

    if (this._stageEntries.has(actor)) {
      let entry = this._stageEntries.get(actor);
      if (entry?.state === "staged") {
        this._completeMinimize(actor);
        return;
      }

      this._relayoutStage(true);
      return;
    }

    let isDraggedBack =
      this._stagePointer?.mode === "stage-pending" &&
      this._stagePointer?.metaWindow === metaWindow;

    this._stopWindowAnimation(actor);
    this._windowActors.add(actor);

    if (!actor._stageDestroySignal) {
      actor._stageDestroySignal = actor.connect("destroy", () => {
        this._removeStageActor(actor);
      });
    }

    actor.remove_all_transitions?.();
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.scale_x = 1;
    actor.scale_y = 1;
    actor.opacity = 255;
    this._setStageVisual(actor, false);
    actor.show();

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    let entry = {
      actor,
      metaWindow,
      target: null,
      clone: null,
      shadow: null,
      state: "minimizing",
      restoreAfterMinimize: false,
    };
    this._stageEntries.set(actor, entry);
    let insertIndex = this._pendingStageInsertIndexes?.get(metaWindow);
    this._pendingStageInsertIndexes?.delete(metaWindow);

    if (Number.isFinite(insertIndex)) {
      insertIndex = Math.clamp(
        Math.round(insertIndex),
        0,
        this._stageOrder.length,
      );
      this._stageOrder.splice(insertIndex, 0, actor);
    } else {
      this._stageOrder.push(actor);
    }

    if (isDraggedBack) {
      let drag = this._stagePointer;
      entry.target = this._getPointerStageTarget(drag, entry);
      this._finishDraggedBackStageMinimize(entry, drag);
      return;
    }

    this._relayoutStage(true);
  }

  _removeStageActor(actor) {
    this._stopWindowAnimation(actor);
    let entry = this._stageEntries.get(actor);
    if (entry) this._destroyStageSurfaces(entry);
    this._stageEntries.delete(actor);
    this._stageOrder = this._stageOrder.filter((item) => item !== actor);
    this._windowActors?.delete(actor);
    this._restoringWindows?.delete(
      actor?.meta_window ?? actor?.get_meta_window?.(),
    );
    this._pendingStageInsertIndexes?.delete(
      actor?.meta_window ?? actor?.get_meta_window?.(),
    );
    this._relayoutStage(true);
  }

  _unstageActor(actor, relayout = true) {
    if (!actor) return;

    let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
    let entry = this._stageEntries.get(actor);
    if (entry) this._destroyStageSurfaces(entry);

    this._stageEntries.delete(actor);
    this._stageOrder = this._stageOrder.filter((item) => item !== actor);
    this._windowActors?.delete(actor);
    this._restoringWindows?.delete(metaWindow);
    this._pendingRestoreTargets?.delete(metaWindow);
    this._pendingStageInsertIndexes?.delete(metaWindow);
    this._stopWindowAnimation(actor);

    try {
      actor.remove_all_transitions?.();
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
      this._setStageVisual(actor, false);
      actor.set_pivot_point?.(0, 0);
    } catch {}

    try {
      if (actor._stageDestroySignal) {
        actor.disconnect(actor._stageDestroySignal);
        actor._stageDestroySignal = 0;
      }
    } catch {}

    if (relayout) this._relayoutStage(true);
  }

  _getStageGeometry(actor) {
    let [width, height] = actor.get_size();
    if (width <= 0 || height <= 0) return null;

    // let scale = STAGE_EDGE_SIZE / width;
    let scale = STAGE_EDGE_SIZE / Math.max(width, height);
    return {
      scale,
      width: width * scale,
      height: height * scale,
    };
  }

  _isStageTargetVisible(target) {
    let monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !target) return true;

    return (
      target.y < monitor.y + monitor.height &&
      target.y + target.height + STAGE_INFO_ROW_HEIGHT > monitor.y &&
      target.x < monitor.x + monitor.width &&
      target.x + target.width > monitor.x
    );
  }

  _relayoutStage(animate, duration = stageOn_duration_minimize) {
    let monitor = Main.layoutManager.primaryMonitor;
    let area = this._getStageArea(monitor);
    if (!monitor || !area) return;

    let entries = this._stageOrder
      .map((actor) => this._stageEntries.get(actor))
      .filter(
        (entry) =>
          entry?.actor &&
          !entry.actor.is_destroyed?.() &&
          entry.state !== "restoring",
      );
    let geometries = entries.map((entry) =>
      this._getStageGeometry(entry.actor),
    );
    if (geometries.some((geometry) => !geometry)) return;

    let infoHeight = entries.length * STAGE_INFO_ROW_HEIGHT;
    let baseHeight = geometries.reduce(
      (sum, geometry) => sum + geometry.height,
      infoHeight,
    );
    if (geometries.length > 1)
      baseHeight += STAGE_GAP * (geometries.length - 1);

    let fitScale = Math.min(1, area.height / Math.max(1, baseHeight));
    let overflowScale =
      fitScale < STAGE_MIN_SCROLL_SCALE ? STAGE_MIN_SCROLL_SCALE : fitScale;
    let contentHeight = geometries.reduce(
      (sum, geometry) => sum + geometry.height * overflowScale,
      infoHeight,
    );
    if (geometries.length > 1)
      contentHeight += STAGE_GAP * (geometries.length - 1);

    this._stageMaxScroll = Math.max(0, contentHeight - area.height);
    this._stageScrollOffset = Math.clamp(
      this._stageScrollOffset,
      0,
      this._stageMaxScroll,
    );

    this.heightStageCenter = contentHeight;
    let y =
      this._stageMaxScroll > 0
        ? area.y - this._stageScrollOffset
        : area.y + (area.height - contentHeight) / 2;

    entries.forEach((entry, index) => {
      let geometry = geometries[index];
      let scale = geometry.scale * overflowScale;
      let height = geometry.height * overflowScale;
      let width = geometry.width * overflowScale;
      let target = {
        x: area.x + STAGE_LEFT_OFFSET,
        y,
        width,
        height,
        scale,
      };
      entry.target = target;
      this._moveActorToStage(entry, target, animate, duration);
      y += height + STAGE_INFO_ROW_HEIGHT + STAGE_GAP;
    });

    this._purgeOrphanStageSurfaces();
    this._updateCoverLayer();
  }

  _moveActorToStage(
    entry,
    target,
    animate,
    duration = stageOn_duration_minimize,
  ) {
    if (entry.state === "minimizing") {
      this._moveWindowActorToStage(entry, target, animate, duration);
      return;
    }

    if (this._isDraggingStageEntry(entry)) {
      this._updateStageShadow(entry, target, false);
      this._syncStageStack(entry);
      return;
    }

    let actor = entry.shadow;
    if (!actor || actor.is_destroyed?.()) return;

    this._stopWindowAnimation(actor);
    this._stopWindowAnimation(entry.clone);
    this._stopWindowAnimation(entry.mirror);
    this._stopWindowAnimation(entry.mirrorRotate);
    actor.remove_all_transitions?.();
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.opacity = 255;
    actor.visible = this._isStageTargetVisible(target);
    if (entry.clone) entry.clone.visible = actor.visible;
    if (entry.mirror) entry.mirror.visible = actor.visible;
    if (entry.mirrorRotate) entry.mirrorRotate.visible = actor.visible;
    if (!actor.visible) {
      this._hideStageSourceActor(entry);
      return;
    }
    actor.show();
    entry.mirror?.show?.();
    entry.mirrorRotate?.show?.();
    entry.clone?.show?.();

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    this._setStageVisual(actor, true);
    this._updateStageShadow(entry, target, animate && entry.state === "staged");
    this._syncStageStack(entry);

    if (!animate) {
      actor.set_position(target.x, target.y);
      actor.set_scale(1, 1);
      this._setStageVisual(actor, true);
      return;
    }

    this._animateActor(
      actor,
      {
        x: target.x,
        y: target.y,
        scale: 1,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration,
        cubic: stageOn_cubic_minimize,
        opacityDelay: DelayOpacity_minimize,
        opacityDuration: OpacityDuration,
        onUpdate: (surface) =>
          this._syncStageSourceActor(entry, target, surface),
        onComplete: () => this._syncStageSourceActor(entry, target, actor),
      },
    );
  }

  _moveWindowActorToStage(
    entry,
    target,
    animate,
    duration = stageOn_duration_minimize,
  ) {
    let actor = entry.actor;
    if (!actor || actor.is_destroyed?.()) return;

    actor.remove_all_transitions?.();
    actor.opacity = 255;
    actor.show();

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    let { x, y } = this._getActorPosition(actor);
    let translationX = target.x - x;
    let translationY = target.y - y;

    if (!animate) {
      this._stopWindowAnimation(actor);
      actor.translation_x = translationX;
      actor.translation_y = translationY;
      actor.scale_x = target.scale;
      actor.scale_y = target.scale;
      actor.opacity = 255;
      this._setStageVisual(actor, true);
      this._finishStageMinimize(entry);
      return;
    }

    this._animateActorTransform(
      actor,
      {
        translationX,
        translationY,
        scale: target.scale,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration,
        cubic: stageOn_cubic_minimize,
        onComplete: () => {
          this._finishStageMinimize(entry);
        },
      },
    );
  }

  _finishDraggedBackStageMinimize(entry, drag) {
    if (!entry || !drag || entry.state !== "minimizing") return;
    if (!entry.actor || entry.actor.is_destroyed?.() || !entry.target) return;

    let actor = entry.actor;
    let target = entry.target;
    let startState =
      drag.stageMinimizeStart ?? this._getActorVisualState(actor);
    let startScale = (startState?.scaleX ?? 1) / Math.max(target.scale, 0.001);

    this._createStageSurfaces(entry);
    entry.mirror.opacity = 255;
    entry.mirror.show?.();
    entry.mirrorRotate.show?.();
    entry.clone.show?.();
    entry.shadow?.show?.();
    this._setStageVisual(entry.shadow, true);
    entry.state = "staged";
    this._updateStageShadow(entry, target, false);

    entry.shadow.set_position(
      startState?.x ?? target.x,
      startState?.y ?? target.y,
    );
    entry.shadow.set_scale(startScale, startScale);
    entry.shadow.opacity = 255;
    this._setRotationY(entry.mirrorRotate, 0);
    this._setStageMirrorVisual(entry, true, true, STAGE_ACTIVE_DURATION);
    this._completeMinimize(actor);
    this._syncStageStack(entry);

    drag.mode = "stage";
    drag.entry = entry;
    drag.actor = null;
    drag.metaWindow = null;
    drag.localStageX = Math.max(0, drag.lastX - target.x);
    drag.localStageY = Math.max(0, drag.lastY - target.y);
    drag.localWindowX = Math.max(
      0,
      (drag.lastX - target.x) / Math.max(target.scale, 0.001),
    );
    drag.localWindowY = Math.max(
      0,
      (drag.lastY - target.y) / Math.max(target.scale, 0.001),
    );
    this._setStageEntryActive(entry, true);

    this._animateActor(
      entry.shadow,
      {
        x: target.x,
        y: target.y,
        scale: 1,
        opacity: STAGE_ACTIVE_OPACITY,
        rotationY: 0,
      },
      {
        duration: stageOn_duration_minimize,
        cubic: stageOn_cubic_minimize,
      },
    );

    if (drag.releaseAfterStage) {
      this._setStageEntryActive(entry, false);
      this._clearStagePointer();
      this._relayoutStage(true);
    }
  }

  _finishStageMinimize(entry) {
    if (!entry || entry.state !== "minimizing") return;
    if (!entry.actor || entry.actor.is_destroyed?.()) return;
    if (!entry.target) return;

    this._createStageSurfaces(entry);
    entry.mirror.opacity = 255;
    entry.mirror.show?.();
    entry.mirrorRotate.show?.();
    entry.clone.show?.();
    entry.shadow?.show?.();
    this._setStageVisual(entry.shadow, true);
    entry.state = "staged";
    this._updateStageShadow(entry, entry.target, false);
    this._setRotationY(entry.mirrorRotate, 0);
    this._setStageMirrorVisual(entry, true, true, STAGE_ACTIVE_DURATION);
    this._completeMinimize(entry.actor);
    this._syncStageStack(entry);

    if (
      this._stagePointer?.mode === "stage-pending" &&
      this._stagePointer?.metaWindow === entry.metaWindow
    ) {
      let drag = this._stagePointer;
      drag.mode = "stage";
      drag.entry = entry;
      drag.actor = null;
      drag.metaWindow = null;
      drag.localStageX = Math.max(0, drag.lastX - entry.target.x);
      drag.localStageY = Math.max(0, drag.lastY - entry.target.y);
      drag.localWindowX = Math.max(
        0,
        (drag.lastX - entry.target.x) / Math.max(entry.target.scale, 0.001),
      );
      drag.localWindowY = Math.max(
        0,
        (drag.lastY - entry.target.y) / Math.max(entry.target.scale, 0.001),
      );
      this._setStageEntryActive(entry, true);
      this._moveDraggedStageEntry(drag, drag.lastX, drag.lastY);
      if (drag.releaseAfterStage) {
        this._setStageEntryActive(entry, false);
        this._clearStagePointer();
        this._relayoutStage(true);
      }
      return;
    }

    if (entry.restoreAfterMinimize) this._restoreStageEntry(entry);
    else this._updateCoverLayer();
  }

  _activateStageEntryAt(x, y) {
    for (let i = this._stageOrder.length - 1; i >= 0; i--) {
      let entry = this._stageEntries.get(this._stageOrder[i]);
      if (entry?.state === "restoring") continue;

      if (this._getStageEntryHit(entry, x, y)) {
        this._restoreStageEntry(entry);
        return;
      }
    }
  }

  _getCurrentStageTarget(entry) {
    if (!entry?.target) return null;

    let source = entry.shadow ?? entry.clone ?? entry.actor;
    if (!source || source.is_destroyed?.()) return entry.target;

    return {
      ...entry.target,
      x: source.x ?? source.get_x?.() ?? entry.target.x,
      y: source.y ?? source.get_y?.() ?? entry.target.y,
      scale: entry.target.scale,
    };
  }

  _restoreStageEntry(entry, options = {}) {
    let { actor, metaWindow, target } = entry;
    if (!actor || !metaWindow) return;
    if (this._restoringWindows.has(metaWindow)) return;

    let replaceIndex = this._stageOrder.indexOf(actor);
    if (replaceIndex < 0) replaceIndex = null;

    if (entry.state === "minimizing") {
      if (!target) {
        this._relayoutStage(false);
        target = entry.target;
      }

      this._stopWindowAnimation(actor);
      this._finishStageMinimize(entry);
      target = entry.target;

      if (entry.state !== "staged") {
        entry.restoreAfterMinimize = true;
        return;
      }
    }

    if (entry.state === "restoring") return;

    if (!target) {
      this._relayoutStage(false);
      target = entry.target;
    }
    target = this._getCurrentStageTarget(entry) ?? target;
    if (!target) return;

    this._stopWindowAnimation(entry.clone);
    this._stopWindowAnimation(entry.shadow);
    entry.state = "restoring";
    this._restoringWindows.add(metaWindow);
    this._pendingRestoreTargets.set(metaWindow, {
      target,
      entry,
      dragInfo: options.dragInfo ?? null,
      minimizeOthers: options.minimizeOthers ?? true,
      activate: options.activate ?? true,
      replaceIndex,
    });

    if ((options.minimizeOthers ?? true) && !this._restoringAllStageWindows)
      this._minimizeVisibleWindowsExcept(metaWindow, replaceIndex);

    metaWindow.unminimize();
    this._relayoutStage(true);
  }

  _handleStageUnminimize(actor) {
    let metaWindow = actor.meta_window ?? actor.get_meta_window?.();

    if (this._pendingStageWindows.has(metaWindow)) {
      this._pendingStageWindows.delete(metaWindow);
      this._completeUnminimize(actor);
      this._addStageIdle(() => {
        if (this._stageMode && !metaWindow.minimized) metaWindow.minimize();
        return GLib.SOURCE_REMOVE;
      });
      return;
    }

    if (
      this._restoringWindows.has(metaWindow) &&
      !this._pendingRestoreTargets.has(metaWindow)
    )
      return;

    let pendingRestore = this._pendingRestoreTargets.get(metaWindow);
    let stageTarget = pendingRestore?.target;
    let entry = pendingRestore?.entry;
    let replaceIndex = pendingRestore?.replaceIndex ?? null;
    if (!stageTarget) {
      entry = this._stageOrder
        .map((stageActor) => this._stageEntries.get(stageActor))
        .find((item) => item?.metaWindow === metaWindow);
      if (entry) {
        stageTarget = entry.target;
        entry.state = "restoring";
      }
    }

    if (entry && !Number.isFinite(replaceIndex)) {
      replaceIndex = this._stageOrder.indexOf(entry.actor);
      if (replaceIndex < 0) replaceIndex = null;
    }

    if (!stageTarget) {
      this._completeUnminimize(actor);
      if (this._stageMode) this._minimizeVisibleWindowsExcept(metaWindow);
      return;
    }

    if (!pendingRestore && this._stageMode && !this._restoringAllStageWindows)
      this._minimizeVisibleWindowsExcept(metaWindow, replaceIndex);

    this._pendingRestoreTargets.delete(metaWindow);
    this._restoringWindows.add(metaWindow);
    if (entry) {
      entry.state = "restoring";
      this._stageEntries.delete(entry.actor);
      this._stageOrder = this._stageOrder.filter(
        (item) => item !== entry.actor,
      );
    }

    if (pendingRestore?.dragInfo) {
      if (pendingRestore.dragInfo.restoreTarget)
        stageTarget = pendingRestore.dragInfo.restoreTarget;
      this._finishDragOutUnminimize(
        actor,
        metaWindow,
        stageTarget,
        entry,
        pendingRestore.dragInfo,
      );
      this._relayoutStage(true);
      return;
    }

    this._animateStageActorToWindow(
      actor,
      metaWindow,
      stageTarget,
      entry,
      pendingRestore?.activate ?? true,
    );
    this._relayoutStage(true);
  }

  _animateStageSurfaceToWindow(entry, actor, stageTarget, duration) {
    let surface = entry?.shadow;
    if (!surface || surface.is_destroyed?.() || !stageTarget) return;

    this._stopWindowAnimation(surface);
    surface.remove_all_transitions?.();
    surface._originStageRestoring = true;
    surface.show?.();
    surface.opacity = 255;
    surface.set_position(stageTarget.x, stageTarget.y);
    surface.set_scale(1, 1);
    this._setStageVisual(surface, true);

    if (entry.mirror && !entry.mirror.is_destroyed?.()) {
      entry.mirror.opacity = 255;
      entry.mirror.set_scale(stageTarget.scale, stageTarget.scale);
      entry.mirror.show?.();
      entry.mirrorRotate?.show?.();
      entry.clone?.show?.();
      this._setStageMirrorVisual(
        entry,
        false,
        true,
        Math.min(duration, STAGE_ACTIVE_DURATION),
      );
    }

    let { x, y } = this._getActorPosition(actor);
    let targetScale = 1 / Math.max(stageTarget.scale, 0.001);
    this._animateActor(
      surface,
      {
        x,
        y,
        scale: targetScale,
        opacity: 0,
        rotationY: 0,
      },
      {
        duration,
        cubic: stageOn_cubic_uminimize,
        opacityDuration: STAGE_CROSSFADE_DURATION,
        onComplete: () => this._destroyStageSurfaces(entry),
      },
    );
  }

  _finishDragOutUnminimize(actor, metaWindow, stageTarget, entry, dragInfo) {
    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();
    actor.opacity = 1;
    actor.show();
    this._raiseWindowActor(actor);

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    dragInfo.mode = "window";
    dragInfo.actor = actor;
    dragInfo.metaWindow = metaWindow;
    dragInfo.entry = null;
    dragInfo.released = !!dragInfo.released;

    if (metaWindow.get_maximized?.() !== 0)
      metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

    this._applyDraggedWindowMove(dragInfo, dragInfo.lastX, dragInfo.lastY);
    this._setStageVisual(actor, true);

    this._animateStageSurfaceToWindow(
      entry,
      actor,
      stageTarget,
      DURATION_drag_out_unminimize,
    );

    this._animateActorTransform(
      actor,
      {
        translationX: 0,
        translationY: 0,
        scale: 1,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration: DURATION_drag_out_unminimize,
        cubic: stageOn_cubic_uminimize,
        opacityDuration: STAGE_CROSSFADE_DURATION,
        onComplete: () => {
          this._restoringWindows.delete(metaWindow);
          this._resetWindowActor(actor);
          this._completeUnminimize(actor);
          this._raiseWindowActor(actor);

          dragInfo.mode = "window";
          dragInfo.restoreTarget = null;
          if (this._stagePointer === dragInfo && !dragInfo.released) {
            dragInfo.activateOnRelease = true;
            this._moveDraggedWindow(dragInfo, dragInfo.lastX, dragInfo.lastY);
          } else {
            metaWindow.activate(global.get_current_time());
            this._ensureWindowInsideMonitor(metaWindow, true);
            if (this._stagePointer === dragInfo) this._clearStagePointer();
          }

          this._updateCoverLayer();
        },
      },
    );
  }

  _animateStageActorToWindow(
    actor,
    metaWindow,
    stageTarget,
    entry = null,
    activate = true,
  ) {
    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();
    actor.opacity = 1;
    actor.show();

    if (typeof actor.set_pivot_point === "function")
      actor.set_pivot_point(0, 0);

    let { x, y } = this._getActorPosition(actor);
    actor.translation_x = stageTarget.x - x;
    actor.translation_y = stageTarget.y - y;
    actor.scale_x = stageTarget.scale;
    actor.scale_y = stageTarget.scale;
    this._setStageVisual(actor, true);
    this._animateStageSurfaceToWindow(
      entry,
      actor,
      stageTarget,
      stageOn_duration_unminimize,
    );

    this._animateActorTransform(
      actor,
      {
        translationX: 0,
        translationY: 0,
        scale: 1,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration: stageOn_duration_unminimize,
        cubic: stageOn_cubic_uminimize,
        opacityDuration: STAGE_CROSSFADE_DURATION,
        onComplete: () => {
          this._restoringWindows.delete(metaWindow);
          this._resetWindowActor(actor);
          this._completeUnminimize(actor);
          if (activate) metaWindow.activate(global.get_current_time());
          this._updateCoverLayer();
        },
      },
    );
  }

  _minimizeVisibleWindowsExcept(exceptMetaWindow, insertIndex = null) {
    if (!this._stageMode) return;

    let nextInsertIndex = Number.isFinite(insertIndex)
      ? Math.max(0, Math.round(insertIndex))
      : null;

    for (let actor of global.get_window_actors()) {
      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      if (!this._isStageWindow(metaWindow)) continue;
      if (metaWindow === exceptMetaWindow) continue;
      if (this._pendingStageWindows.has(metaWindow)) continue;
      if (this._stageEntries.has(actor)) continue;
      if (metaWindow.minimized) continue;

      this._restoringWindows.delete(metaWindow);
      this._pendingRestoreTargets.delete(metaWindow);
      if (nextInsertIndex !== null)
        this._pendingStageInsertIndexes.set(metaWindow, nextInsertIndex++);
      metaWindow.minimize();
      if (!this._stageEntries.has(actor)) this._stageMinimizeActor(actor);
    }
  }

  _easeIcon(icon, fromX, fromY, fromScale, delay) {
    let start = () => {
      let startTime = GLib.get_monotonic_time();
      let frameId = 0;

      frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_INTERVAL, () => {
        let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        let linear = elapsed / DURATION;
        let eased = _cubicBezierProgress(...CUBIC_BEZIER, linear);
        let inv = 1 - eased;

        icon.translation_x = fromX * inv;
        icon.translation_y = fromY * inv;
        icon.scale_x = 1 + (fromScale - 1) * inv;
        icon.scale_y = 1 + (fromScale - 1) * inv;
        icon.opacity = Math.clamp(Math.round(255 * eased), 0, 255);

        if (linear < 1) return GLib.SOURCE_CONTINUE;

        icon.translation_x = 0;
        icon.translation_y = 0;
        icon.scale_x = 1;
        icon.scale_y = 1;
        icon.opacity = 255;
        this._removeTimeout(frameId);
        return GLib.SOURCE_REMOVE;
      });

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
}

const ANIM_KEY = Symbol("anim");

function animateActor(actor, keyframe, options = {}) {
  const GLib = imports.gi.GLib;
  const Clutter = imports.gi.Clutter;
  if (!actor || actor.is_finalized?.()) return;
  actor.set_pivot_point(0.5, 0.5);

  const props = [
    ["scaleX", "scale_x"],
    ["scaleY", "scale_y"],
    ["scale", "scale_x", "scale_y"],
    ["translateX", "translation_x"],
    ["translateY", "translation_y"],
    ["translate", "translation_x", "translation_y"],
    ["rotateX", "rotation_angle_x"],
    ["rotateY", "rotation_angle_y"],
    ["rotateZ", "rotation_angle_z"],
    ["opacity", "opacity"],
  ];

  let active = [];

  let startTime = Clutter.get_current_frame_time() / 1000;

  for (let [key, p1, p2] of props) {
    if (keyframe[key] === undefined) continue;
    let start = actor[p1],
      end = keyframe[key];
    if (start !== end) {
      let opt = options[key] || options;
      active.push({
        fields: [p1, p2].filter(Boolean),
        start,
        end,
        dur: opt.duration ?? 500,
        bz: opt.bezier ?? [0.25, 0.1, 0.25, 1],
      });
    }
  }

  if (actor[ANIM_KEY]) GLib.source_remove(actor[ANIM_KEY]);
  if (!active.length) return delete actor[ANIM_KEY];

  actor[ANIM_KEY] = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 16, () => {
    if (!actor || actor.is_finalized?.()) return GLib.SOURCE_REMOVE;

    let now = Clutter.get_current_frame_time() / 1000;
    let allDone = true;

    for (let a of active) {
      let p = Math.max(0, Math.min(1, (now - startTime) / a.dur));

      let ease = _cubicBezierProgress(a.bz[0], a.bz[1], a.bz[2], a.bz[3], p);

      let val = a.start + (a.end - a.start) * ease;

      a.fields.forEach((f) => (actor[f] = val));
      if (p < 1) allDone = false;
    }

    if (allDone) {
      delete actor[ANIM_KEY];
      options.onComplete?.();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  });
}
