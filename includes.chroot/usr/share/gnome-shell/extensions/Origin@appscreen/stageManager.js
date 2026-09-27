"use strict";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import { StageModeIndicator } from "./stageManagerQuickSettings.js";
import { _nullCloneSources } from "./helper.js";
import {
  CUBIC_BEZIER, DURATION, DURATION_drag_out_unminimize,
  FRAME_INTERVAL,
  STAGE_ACTIVE_DURATION, STAGE_ACTIVE_OPACITY,
  STAGE_CROSSFADE_DURATION, STAGE_EDGE_REVEAL_DELAY, STAGE_EDGE_REVEAL_SIZE,
  STAGE_EDGE_SIZE, STAGE_GAP, STAGE_HEIGHT_RATIO,
  STAGE_INFO_GAP, STAGE_INFO_ICON_SIZE,
  STAGE_INFO_LABEL_STYLE, STAGE_INFO_ROW_HEIGHT, STAGE_INFO_TOP_MARGIN,
  STAGE_LEFT_OFFSET, STAGE_MIN_SCROLL_SCALE, STAGE_RESERVED_WIDTH,
  STAGE_ROTATION_Y, STAGE_SHADOW_PAD, STAGE_SHADOW_STYLE,
  WORKSPACE_SWITCH_UNMINIMIZE_WINDOW, drag_duration, minimizeOpacityDelay,
  minimizeOpacityIcon, other_cubic, other_duration_2, STAGE_SHOW_DELAY,
  STAGE_SHOW_HIDE_DELAY_RATIO, stageOn_cubic_minimize,
  stageOn_cubic_uminimize, stageOn_duration_minimize, stageOn_duration_unminimize,
} from "./config.js";
import {
  _getProgressedCubic, _progressFromCubicTable, _updateCurrentProgressedCubics,
} from "./animationEngine.js";

/** Stage Manager lifecycle, layout, preview surfaces, and mode switching. */
export const StageManagerMixin = Base => class extends Base {
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

  _connectStageActorSignals(actor, metaWindow) {
    if (!actor) return;

    if (actor._stageDestroySignal) {
      try {
        actor.disconnect(actor._stageDestroySignal);
      } catch {}
      actor._stageDestroySignal = 0;
    }

    actor._stageDestroySignal = actor.connect("destroy", () => {
      this._removeStageActor(actor, true);
    });

    if (!metaWindow || this._stageUnmanagedSignals.has(metaWindow)) return;

    try {
      let unmanagedId = metaWindow.connect("unmanaged", () => {
        this._removeStageActor(actor, true, metaWindow);
      });
      this._stageUnmanagedSignals.set(metaWindow, unmanagedId);
    } catch {}
  }

  _disconnectStageActorSignals(actor, metaWindow = null) {
    if (actor?._stageDestroySignal) {
      try {
        actor.disconnect(actor._stageDestroySignal);
      } catch {}
      actor._stageDestroySignal = 0;
    }

    metaWindow ??= actor?.meta_window ?? actor?.get_meta_window?.();
    let unmanagedId = this._stageUnmanagedSignals?.get(metaWindow);
    if (!unmanagedId) return;

    try {
      metaWindow.disconnect(unmanagedId);
    } catch {}
    this._stageUnmanagedSignals.delete(metaWindow);
  }

  _disconnectAllStageUnmanagedSignals() {
    for (let [metaWindow, unmanagedId] of this._stageUnmanagedSignals ?? []) {
      try {
        metaWindow.disconnect(unmanagedId);
      } catch {}
    }

    this._stageUnmanagedSignals?.clear();
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
    this._destroyStageHitActor(entry);

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

  _ensureStageHitActor(entry) {
    let actor = entry?.actor;
    if (!actor) return null;

    let hitActor = this._stageHitActors?.get(actor);
    if (hitActor && !hitActor.is_destroyed?.()) return hitActor;

    hitActor = new St.Widget({
      reactive: true,
      visible: false,
      style: "background-color: rgba(0, 0, 0, 0.001);",
    });
    hitActor._originStageHitEntry = entry;
    hitActor.connect("button-press-event", (box, event) =>
      this._onStageButtonPress(event),
    );
    hitActor.connect("touch-event", (box, event) =>
      this._onStageTouchEvent(event),
    );
    hitActor.connect("motion-event", (box, event) => {
      let [x, y] = event.get_coords();
      this._clearStageAutoHideCheck();
      this._updateStageHover(x, y);
      return Clutter.EVENT_STOP;
    });
    hitActor.connect("leave-event", () => {
      if (!this._stagePointer) this._clearStageHover();
      this._queueStageAutoHideCheck();
      return Clutter.EVENT_PROPAGATE;
    });
    hitActor.connect("scroll-event", (box, event) =>
      this._onStageScroll(event),
    );
    Main.layoutManager.addTopChrome(hitActor, {
      affectsInputRegion: true,
      affectsStruts: false,
      trackFullscreen: false,
    });
    this._stageHitActors.set(actor, hitActor);
    return hitActor;
  }

  _syncStageHitActor(entry, target) {
    let hitActor = this._ensureStageHitActor(entry);
    if (!hitActor || !target) return;

    if (
      !this._stageMode ||
      this._stageHidden ||
      entry.state === "restoring" ||
      !this._isStageTargetVisible(target)
    ) {
      hitActor.hide();
      return;
    }

    hitActor.set_position(target.x, target.y);
    hitActor.set_size(Math.max(1, target.width), Math.max(1, target.height));
    hitActor.show();
    this._raiseStageUiActor(hitActor);
  }

  _destroyStageHitActor(entryOrActor) {
    let actor = this._stageHitActors?.has(entryOrActor)
      ? entryOrActor
      : entryOrActor?.actor;
    let hitActor = this._stageHitActors?.get(actor);
    if (!hitActor) return;

    this._stageHitActors.delete(actor);
    try {
      Main.layoutManager.removeChrome(hitActor);
    } catch {}
    try {
      hitActor.destroy();
    } catch {}
  }

  _destroyStageHitActors() {
    for (let actor of [...(this._stageHitActors?.keys?.() ?? [])])
      this._destroyStageHitActor(actor);
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

    this._raiseStageUiActor(this._coverLayer);
    this._raiseStageUiActor(this._stageEdgeRevealLayer);
  }

  _raiseStageUiActor(actor) {
    if (!actor?.visible || actor.is_destroyed?.()) return;

    try {
      actor.get_parent?.()?.set_child_above_sibling(actor, null);
    } catch {}
  }

  _raiseWindowActor(actor) {
    if (!actor || actor.is_destroyed?.()) return;

    let parent = actor.get_parent?.() ?? global.window_group;
    try {
      parent.set_child_above_sibling(actor, null);
    } catch {}

    this._raiseStageUiActor(this._coverLayer);
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

  _applyStageHiddenEntryVisual(entry) {
    let shadow = entry?.shadow;
    let target = entry?.target;
    if (!this._stageHidden || !shadow || shadow.is_destroyed?.() || !target)
      return;

    this._stopWindowAnimation(shadow);
    shadow.remove_all_transitions?.();
    shadow.set_pivot_point?.(0, 0);
    shadow.set_position(target.x, target.y + target.height / 2);
    shadow.set_scale(0, 0);
    shadow.opacity = 255;
    this._syncStageSourceActor(entry, target, shadow);
    this._syncStageHitActor(entry, target);
    this._syncStageCoverLayer();
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
      style: "background-color: rgba(0, 0, 0, 0.001);",
    });
    this._coverLayerPressSignal = this._coverLayer.connect(
      "button-press-event",
      (cover, event) => this._onStageButtonPress(event),
    );
    this._coverLayerTouchSignal = this._coverLayer.connect(
      "touch-event",
      (cover, event) => this._onStageTouchEvent(event),
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
          this._clearStageAutoHideCheck();
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
        this._queueStageAutoHideCheck();
        return Clutter.EVENT_PROPAGATE;
      },
    );
    this._coverLayerScrollSignal = this._coverLayer.connect(
      "scroll-event",
      (cover, event) => this._onStageScroll(event),
    );
    Main.layoutManager.addTopChrome(this._coverLayer, {
      affectsInputRegion: false,
      affectsStruts: false,
      trackFullscreen: false,
    });
  }

  _destroyCoverLayer() {
    if (!this._coverLayer) return;

    this._clearStagePointer();
    this._clearStageHover();

    if (this._coverLayerPressSignal) {
      this._coverLayer.disconnect(this._coverLayerPressSignal);
      this._coverLayerPressSignal = 0;
    }

    if (this._coverLayerTouchSignal) {
      this._coverLayer.disconnect(this._coverLayerTouchSignal);
      this._coverLayerTouchSignal = 0;
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

    try {
      Main.layoutManager.removeChrome(this._coverLayer);
    } catch {}
    this._coverLayer.destroy();
    this._coverLayer = null;
  }

  _ensureStageEdgeRevealLayer() {
    if (this._stageEdgeRevealLayer) return;

    this._stageEdgeRevealLayer = new St.Widget({
      reactive: true,
      visible: false,
      style: "background-color: rgba(0, 0, 0, 0.001);",
    });
    let reveal = () => {
      this._queueStageEdgeReveal();
      return Clutter.EVENT_STOP;
    };
    this._stageEdgeRevealEnterSignal = this._stageEdgeRevealLayer.connect(
      "enter-event",
      reveal,
    );
    this._stageEdgeRevealMotionSignal = this._stageEdgeRevealLayer.connect(
      "motion-event",
      reveal,
    );
    this._stageEdgeRevealPressSignal = this._stageEdgeRevealLayer.connect(
      "button-press-event",
      () => {
        this._queueStageEdgeReveal(0);
        return Clutter.EVENT_STOP;
      },
    );
    this._stageEdgeRevealLeaveSignal = this._stageEdgeRevealLayer.connect(
      "leave-event",
      () => {
        this._clearStageEdgeReveal();
        return Clutter.EVENT_PROPAGATE;
      },
    );
    Main.layoutManager.addTopChrome(this._stageEdgeRevealLayer, {
      affectsInputRegion: true,
      affectsStruts: false,
      trackFullscreen: false,
    });
  }

  _destroyStageEdgeRevealLayer() {
    this._clearStageEdgeReveal();
    if (!this._stageEdgeRevealLayer) return;

    for (let signal of [
      "_stageEdgeRevealEnterSignal",
      "_stageEdgeRevealMotionSignal",
      "_stageEdgeRevealPressSignal",
      "_stageEdgeRevealLeaveSignal",
    ]) {
      if (!this[signal]) continue;
      this._stageEdgeRevealLayer.disconnect(this[signal]);
      this[signal] = 0;
    }

    try {
      Main.layoutManager.removeChrome(this._stageEdgeRevealLayer);
    } catch {}
    this._stageEdgeRevealLayer.destroy();
    this._stageEdgeRevealLayer = null;
  }

  _connectStageInputCapture() {
    if (this._stageInputCaptureSignal) return;

    this._stageInputCaptureSignal = global.stage.connect(
      "captured-event",
      (stage, event) => this._onStageInputCapturedEvent(event),
    );
  }

  _disconnectStageInputCapture() {
    if (!this._stageInputCaptureSignal) return;

    global.stage.disconnect(this._stageInputCaptureSignal);
    this._stageInputCaptureSignal = 0;
  }

  _connectMonitorChanged() {
    if (this._monitorChangedSignal) return;

    this._monitorChangedSignal = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        this._stageOffsetX = this._stageHidden
          ? this._getStageHiddenOffset()
          : 0;
        this._relayoutStage(false);
        this._queueStageAutoHideCheck();
      },
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
      this._stageRestackedSignal = global.display.connect("restacked", () => {
        this._raiseStageStack();
        this._queueStageAutoHideCheck();
      });
    } catch {
      this._stageRestackedSignal = 0;
    }

    try {
      this._stageFocusSignal = global.display.connect(
        "notify::focus-window",
        () => {
          this._trackStageFocusedWindow();
          this._queueStageAutoHideCheck();
        },
      );
      this._trackStageFocusedWindow();
    } catch {
      this._stageFocusSignal = 0;
    }

    try {
      this._stageSizeChangeSignal = global.window_manager.connect(
        "size-change",
        () => this._queueStageAutoHideCheck(0),
      );
    } catch {
      this._stageSizeChangeSignal = 0;
    }

    try {
      this._stageSizeChangedSignal = global.window_manager.connect(
        "size-changed",
        () => this._queueStageAutoHideCheck(0),
      );
    } catch {
      this._stageSizeChangedSignal = 0;
    }
  }

  _disconnectStageStackSignals() {
    if (this._stageRestackedSignal) {
      try {
        global.display.disconnect(this._stageRestackedSignal);
      } catch {}
      this._stageRestackedSignal = 0;
    }

    if (this._stageFocusSignal) {
      try {
        global.display.disconnect(this._stageFocusSignal);
      } catch {}
      this._stageFocusSignal = 0;
    }

    if (this._stageSizeChangeSignal) {
      try {
        global.window_manager.disconnect(this._stageSizeChangeSignal);
      } catch {}
      this._stageSizeChangeSignal = 0;
    }

    if (this._stageSizeChangedSignal) {
      try {
        global.window_manager.disconnect(this._stageSizeChangedSignal);
      } catch {}
      this._stageSizeChangedSignal = 0;
    }

    this._disconnectStageFocusedWindowSignals();
  }

  _connectStageCleanupSignals() {
    if (!this._stageWindowDestroySignal) {
      try {
        this._stageWindowDestroySignal = global.window_manager.connect(
          "destroy",
          (wm, actor) => this._onStageWindowDestroyed(actor),
        );
      } catch {
        this._stageWindowDestroySignal = 0;
      }
    }

    if (!this._overviewHiddenSignal) {
      try {
        this._overviewHiddenSignal = Main.overview.connect("hidden", () =>
          this._queueStageWindowCleanup(),
        );
      } catch {
        this._overviewHiddenSignal = 0;
      }
    }
  }

  _disconnectStageCleanupSignals() {
    if (this._stageWindowDestroySignal) {
      try {
        global.window_manager.disconnect(this._stageWindowDestroySignal);
      } catch {}
      this._stageWindowDestroySignal = 0;
    }

    if (this._overviewHiddenSignal) {
      try {
        Main.overview.disconnect(this._overviewHiddenSignal);
      } catch {}
      this._overviewHiddenSignal = 0;
    }
  }

  _markWorkspaceSwitch() {
    this._activeWorkspace = global.workspace_manager.get_active_workspace();
    this._lastWorkspaceSwitchUs = GLib.get_monotonic_time();
    this._queueStageAutoHideCheck();
  }

  _isWorkspaceJumpUnsafe() {
    let activeWorkspace = global.workspace_manager.get_active_workspace();
    let workspaceJumped =
      this._activeWorkspace && activeWorkspace !== this._activeWorkspace;
    let recentlySwitched =
      this._lastWorkspaceSwitchUs > 0 &&
      (GLib.get_monotonic_time() - this._lastWorkspaceSwitchUs) / 1000 <
        WORKSPACE_SWITCH_UNMINIMIZE_WINDOW;

    this._activeWorkspace = activeWorkspace;
    return workspaceJumped || recentlySwitched;
  }

  _connectWorkspaceSwitchSignals() {
    if (this._workspaceSwitchSignal) return;

    this._workspaceSwitchSignal = global.window_manager.connect(
      "switch-workspace",
      () => this._markWorkspaceSwitch(),
    );
    this._workspaceActiveSignal = global.workspace_manager.connect(
      "active-workspace-changed",
      () => this._markWorkspaceSwitch(),
    );
  }

  _disconnectWorkspaceSwitchSignals() {
    if (this._workspaceSwitchSignal) {
      global.window_manager.disconnect(this._workspaceSwitchSignal);
      this._workspaceSwitchSignal = 0;
    }

    if (this._workspaceActiveSignal) {
      global.workspace_manager.disconnect(this._workspaceActiveSignal);
      this._workspaceActiveSignal = 0;
    }

    this._lastWorkspaceSwitchUs = 0;
    this._activeWorkspace = null;
  }

  _clearStageWindowCleanup() {
    if (!this._stageWindowCleanupId) return;

    GLib.Source.remove(this._stageWindowCleanupId);
    this._stageWindowCleanupId = 0;
  }

  _queueStageWindowCleanup() {
    if (
      !this._stageMode &&
      !this._stageEntries?.size &&
      !this._pendingStageWindows?.size &&
      !this._pendingRestoreTargets?.size &&
      !this._restoringWindows?.size
    )
      return;

    this._clearStageWindowCleanup();

    this._stageWindowCleanupId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      80,
      () => {
        this._stageWindowCleanupId = 0;
        this._cleanupDeadStageWindows();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _onStageWindowDestroyed(actor) {
    let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
    if (this._isManagedWindowActor(actor))
      this._prepareManagedWindowDestroy(actor);
    else if (this._stageEntries?.has(actor))
      this._removeStageActor(actor, true, metaWindow);
    else if (metaWindow) this._removeStageMetaWindow(metaWindow, true);

    this._queueStageWindowCleanup();
    this._queueStageAutoHideCheck();
  }

  _cleanupDeadStageWindows() {
    if (
      !this._stageMode &&
      !this._stageEntries?.size &&
      !this._pendingStageWindows?.size &&
      !this._pendingRestoreTargets?.size &&
      !this._restoringWindows?.size
    )
      return;

    let liveWindows = new Set(global.display.list_all_windows());

    let changed = false;
    for (let [actor, entry] of [...(this._stageEntries ?? [])]) {
      let metaWindow =
        entry?.metaWindow ?? actor?.meta_window ?? actor?.get_meta_window?.();
      let actorDead = !actor || actor.is_destroyed?.();
      let windowDead = !metaWindow || !liveWindows.has(metaWindow);

      if (!actorDead && !windowDead) continue;

      this._removeStageActor(actor, false, metaWindow);
      changed = true;
    }

    for (let [actor, entry] of [...(this._restoringStageEntries ?? [])]) {
      let metaWindow =
        entry?.metaWindow ?? actor?.meta_window ?? actor?.get_meta_window?.();
      let actorDead = !actor || actor.is_destroyed?.();
      let windowDead = !metaWindow || !liveWindows.has(metaWindow);

      if (!actorDead && !windowDead) continue;

      this._removeStageActor(actor, false, metaWindow);
      changed = true;
    }

    for (let metaWindow of [...(this._pendingStageWindows ?? [])]) {
      if (liveWindows.has(metaWindow)) continue;
      this._pendingStageWindows.delete(metaWindow);
      this._pendingStageInsertIndexes?.delete(metaWindow);
      changed = true;
    }

    for (let metaWindow of [...(this._pendingRestoreTargets?.keys?.() ?? [])]) {
      if (liveWindows.has(metaWindow)) continue;
      this._pendingRestoreTargets.delete(metaWindow);
      this._restoringWindows?.delete(metaWindow);
      changed = true;
    }

    for (let metaWindow of [...(this._restoringWindows ?? [])]) {
      if (liveWindows.has(metaWindow)) continue;
      this._restoringWindows.delete(metaWindow);
      changed = true;
    }

    this._purgeOrphanStageSurfaces();
    if (changed) {
      this._relayoutStage(true);
      this._queueStageAutoHideCheck();
    }
  }

  _getStageHiddenOffset() {
    return 0;
  }

  _getStageOffsetX() {
    return this._stageOffsetX ?? 0;
  }

  _getStageVisualOffsetX() {
    let area = this._getStageArea();
    if (!area) return this._getStageOffsetX();
    if (Math.abs(this._getStageOffsetX()) < 0.5) return 0;

    for (let actor of this._stageOrder ?? []) {
      let entry = this._stageEntries?.get(actor);
      let source = entry?.shadow ?? entry?.actor;
      if (!source || source.is_destroyed?.()) continue;

      let x = source.x ?? source.get_x?.();
      if (Number.isFinite(x)) return x - area.x - STAGE_LEFT_OFFSET;
    }

    return this._getStageOffsetX();
  }

  _getShiftedStageArea(area = this._getStageArea(), visual = false) {
    area ??= this._getStageArea();
    if (!area) return null;
    return {
      ...area,
      x:
        area.x +
        (visual ? this._getStageVisualOffsetX() : this._getStageOffsetX()),
    };
  }

  _syncStageCoverLayer() {
    if (!this._coverLayer || this._stagePointer) return;

    let area = this._getShiftedStageArea(null, true);
    if (!this._stageMode || !this._stageOrder.length || !area) return;

    this._coverLayer.set_position(area.x, area.y);
    this._coverLayer.set_size(area.width, area.height);
  }

  _clearStageAutoHideCheck() {
    if (!this._stageAutoHideId) return;

    GLib.Source.remove(this._stageAutoHideId);
    this._stageAutoHideId = 0;
  }

  _clearStageShowDelay() {
    if (!this._stageShowDelayId) return;

    GLib.Source.remove(this._stageShowDelayId);
    this._stageShowDelayId = 0;
  }

  _clearStageEdgeReveal() {
    if (!this._stageEdgeRevealId) return;

    GLib.Source.remove(this._stageEdgeRevealId);
    this._stageEdgeRevealId = 0;
  }

  _clearStageVisibilityTransition() {
    if (this._stageVisibilityTransitionId) {
      GLib.Source.remove(this._stageVisibilityTransitionId);
      this._stageVisibilityTransitionId = 0;
    }

    this._stageVisibilityTransitioning = false;
  }

  _startStagePointerPoll() {
    if (this._stagePointerPollId) return;

    this._stagePointerPollId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      30,
      () => {
        if (!this._stageMode) {
          this._stagePointerPollId = 0;
          return GLib.SOURCE_REMOVE;
        }

        let now = GLib.get_monotonic_time();
        if (this._stageHidden) {
          if (this._isPointerInStageRevealEdge()) {
            this._stageRevealPointerSinceUs ||= now;
            if (
              (now - this._stageRevealPointerSinceUs) / 1000 >=
              STAGE_EDGE_REVEAL_DELAY
            ) {
              this._clearStageShowDelay();
              this._applyStageHidden(false, true);
            }
          } else {
            this._stageRevealPointerSinceUs = 0;
          }
          return GLib.SOURCE_CONTINUE;
        }

        this._stageRevealPointerSinceUs = 0;
        if (this._isPointerInStageEdge()) {
          this._clearStageAutoHideCheck();
          return GLib.SOURCE_CONTINUE;
        }

        if (
          !this._stagePointer &&
          now - this._stageLastPollAutoHideUs > 120000
        ) {
          this._stageLastPollAutoHideUs = now;
          this._updateStageAutoHide();
        }

        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopStagePointerPoll() {
    if (!this._stagePointerPollId) return;

    GLib.Source.remove(this._stagePointerPollId);
    this._stagePointerPollId = 0;
    this._stageRevealPointerSinceUs = 0;
    this._stageLastPollAutoHideUs = 0;
  }

  _updateStageEdgeRevealLayer() {
    if (!this._stageEdgeRevealLayer) return;

    let area = this._getStageArea();
    if (
      !this._stageMode ||
      !this._stageOrder.length ||
      !this._stageHidden ||
      this._stagePointer ||
      !area
    ) {
      this._stageEdgeRevealLayer.hide();
      return;
    }

    this._stageEdgeRevealLayer.set_position(area.x, area.y);
    this._stageEdgeRevealLayer.set_size(STAGE_EDGE_REVEAL_SIZE, area.height);
    this._stageEdgeRevealLayer.show();
    this._raiseStageUiActor(this._stageEdgeRevealLayer);
  }

  _isPointerInStageRevealEdge() {
    let [x, y] = global.get_pointer?.() ?? [NaN, NaN];
    return this._isInStageRevealEdge(x, y);
  }

  _isInStageRevealEdge(x, y) {
    let area = this._getStageArea();
    if (!area) return false;

    return (
      x >= area.x &&
      x <= area.x + STAGE_EDGE_REVEAL_SIZE &&
      y >= area.y &&
      y <= area.y + area.height
    );
  }

  _isPointerInStageEdge() {
    let [x, y] = global.get_pointer?.() ?? [NaN, NaN];
    return this._isInStageEdge(x, y);
  }

  _queueStageEdgeReveal(delay = STAGE_EDGE_REVEAL_DELAY) {
    if (!this._stageMode || !this._stageHidden) return;

    this._clearStageEdgeReveal();
    this._stageEdgeRevealId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(1, delay),
      () => {
        this._stageEdgeRevealId = 0;
        if (this._stageHidden && this._isPointerInStageRevealEdge()) {
          this._clearStageShowDelay();
          this._applyStageHidden(false, true);
        }
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _queueStageAutoHideCheck(delay = 70) {
    if (!this._stageMode) return;

    this._clearStageAutoHideCheck();
    this._stageAutoHideId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      delay,
      () => {
        this._stageAutoHideId = 0;
        this._updateStageAutoHide();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _updateStageAutoHide() {
    this._setStageHidden(this._stageShouldAutoHide(), true);
  }

  _setStageHidden(hidden, animate = true) {
    hidden = !!hidden;

    if (hidden || !animate) {
      this._clearStageShowDelay();
      this._applyStageHidden(hidden, animate);
      return;
    }

    this._clearStageShowDelay();
    this._stageShowDelayId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      STAGE_SHOW_DELAY,
      () => {
        this._stageShowDelayId = 0;
        if (!this._stageShouldAutoHide()) this._applyStageHidden(false, true);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _applyStageHidden(hidden, animate = true) {
    let offset = hidden ? this._getStageHiddenOffset() : 0;
    if (
      this._stageHidden === hidden &&
      Math.abs(this._getStageOffsetX() - offset) < 0.5
    )
      return;

    if (animate) {
      this._clearStageHoverForVisibilityTransition();
      this._clearStageVisibilityTransition();
      this._stageVisibilityTransitioning = true;
      this._stageVisibilityTransitionId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        other_duration_2 +
          Math.max(0, this._stageEntries?.size ?? 0) *
            STAGE_SHOW_HIDE_DELAY_RATIO +
          40,
        () => {
          this._stageVisibilityTransitionId = 0;
          this._stageVisibilityTransitioning = false;
          return GLib.SOURCE_REMOVE;
        },
      );
    } else {
      this._clearStageVisibilityTransition();
    }

    this._stageHidden = hidden;
    this._stageOffsetX = offset;
    this._updateStageEdgeRevealLayer();
    if (!this._stageMode || !this._stageEntries?.size) {
      this._updateCoverLayer();
      return;
    }

    this._relayoutStage(animate, other_duration_2, other_cubic, true);
  }

  _stageShouldAutoHide() {
    if (!this._stageMode || !this._stageOrder.length || this._stagePointer)
      return false;

    let area = this._getStageArea();
    let monitor = Main.layoutManager.primaryMonitor;
    if (!area || !monitor) return false;
    if (this._isPointerInStageEdge()) return false;

    let stageRight = area.x + area.width;
    let stageBottom = area.y + area.height;
    for (let actor of global.get_window_actors()) {
      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      if (
        actor.is_destroyed?.() ||
        !actor.visible ||
        !metaWindow ||
        metaWindow.minimized ||
        this._stageEntries.has(actor) ||
        this._restoringStageEntries?.has(actor) ||
        metaWindow.skip_taskbar ||
        metaWindow.is_override_redirect?.()
      )
        continue;

      if (
        metaWindow.get_monitor?.() !== Main.layoutManager.primaryIndex ||
        this._isMetaWindowOnOtherWorkspace(metaWindow)
      )
        continue;

      let rect = metaWindow.get_frame_rect?.();
      if (!rect) rect = this._getTransformedActorGeometry(actor);
      if (!rect) continue;

      if (
        rect.x < stageRight &&
        rect.x + rect.width > area.x &&
        rect.y < stageBottom &&
        rect.y + rect.height > area.y
      )
        return true;
    }

    return false;
  }

  _trackStageFocusedWindow() {
    this._disconnectStageFocusedWindowSignals();

    let metaWindow = global.display.focus_window;
    if (!metaWindow) return;

    let refresh = () => this._queueStageAutoHideCheck(0);
    this._stageFocusedWindow = metaWindow;
    for (let signal of [
      "position-changed",
      "size-changed",
      "notify::minimized",
      "unmanaged",
    ]) {
      try {
        this._stageFocusedWindowSignals.push(
          metaWindow.connect(signal, refresh),
        );
      } catch {}
    }
  }

  _disconnectStageFocusedWindowSignals() {
    if (!this._stageFocusedWindow) return;

    for (let id of this._stageFocusedWindowSignals ?? []) {
      try {
        this._stageFocusedWindow.disconnect(id);
      } catch {}
    }

    this._stageFocusedWindow = null;
    this._stageFocusedWindowSignals = [];
  }

  _updateCoverLayer() {
    if (!this._coverLayer) return;

    this._updateStageEdgeRevealLayer();
    if (this._stagePointer) {
      this._coverLayer.set_position(0, 0);
      this._coverLayer.set_size(global.stage.width, global.stage.height);
      this._coverLayer.show();
      this._raiseStageStack();
      return;
    }

    let area = this._getShiftedStageArea(null, true);
    if (!this._stageMode || !this._stageOrder.length || !area) {
      this._clearStageHover();
      this._coverLayer.hide();
      return;
    }

    this._coverLayer.hide();
    this._raiseStageStack();
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
      this._stopStagePointerPoll();
      this._setStageHidden(false, false);
      this._stageMode = false;
      _updateCurrentProgressedCubics(this._stageMode);
      this._stageScrollOffset = 0;
      this._stageMaxScroll = 0;
      this._updateStageToggle();
      this._restoringAllStageWindows = true;
      this._cancelPendingStageWindows(true);
      this._restoreAllStageWindows();
      this._restoringAllStageWindows = false;
      this._updateCoverLayer();
      this._lockStageModeSwitch(
        stageOn_duration_unminimize + minimizeOpacityIcon + 80,
      );
      return;
    }

    this._stageMode = true;
    this._startStagePointerPoll();
    _updateCurrentProgressedCubics(this._stageMode);
    this._setStageHidden(false, false);
    this._stageScrollOffset = 0;
    this._stageMaxScroll = 0;
    this._updateStageToggle();
    this._stageAllWindows();
    this._updateCoverLayer();
    this._queueStageAutoHideCheck();
    this._lockStageModeSwitch(
      stageOn_duration_minimize + minimizeOpacityIcon + 80,
    );
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

  _isLiveMetaWindow(metaWindow) {
    if (!metaWindow) return false;
    return global.display.list_all_windows().includes(metaWindow);
  }

  _getMetaWindowWorkspace(metaWindow) {
    try {
      return metaWindow?.get_workspace?.() ?? null;
    } catch {
      return null;
    }
  }

  _isMetaWindowOnOtherWorkspace(metaWindow) {
    if (!metaWindow || metaWindow.is_on_all_workspaces?.()) return false;

    let workspace = this._getMetaWindowWorkspace(metaWindow);
    let activeWorkspace = global.workspace_manager.get_active_workspace();
    return !!workspace && workspace !== activeWorkspace;
  }

  _activateStageWindowWorkspace(metaWindow) {
    if (!metaWindow || metaWindow.is_on_all_workspaces?.()) return false;

    let workspace = this._getMetaWindowWorkspace(metaWindow);
    let activeWorkspace = global.workspace_manager.get_active_workspace();
    if (!workspace || workspace === activeWorkspace) return false;

    try {
      workspace.activate(global.get_current_time());
      return true;
    } catch {
      return false;
    }
  }

  _activateStageMetaWindow(metaWindow) {
    if (!metaWindow) return;

    let time = global.get_current_time();
    let workspace = this._getMetaWindowWorkspace(metaWindow);
    let activeWorkspace = global.workspace_manager.get_active_workspace();

    try {
      if (
        workspace &&
        workspace !== activeWorkspace &&
        !metaWindow.is_on_all_workspaces?.()
      ) {
        if (typeof workspace.activate_with_focus === "function")
          workspace.activate_with_focus(metaWindow, time);
        else {
          workspace.activate(time);
          metaWindow.activate(time);
        }
        return;
      }

      metaWindow.activate(time);
    } catch {}
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

    let restoringEntry = this._restoringStageEntries?.get(actor);
    let wasRestoring = restoringEntry || this._restoringWindows.has(metaWindow);
    if (wasRestoring) {
      this._restoringWindows.delete(metaWindow);
      this._pendingRestoreTargets.delete(metaWindow);
      if (restoringEntry) {
        this._destroyStageSurfaces(restoringEntry);
        this._restoringStageEntries.delete(actor);
      }
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

    this._connectStageActorSignals(actor, metaWindow);

    actor.remove_all_transitions?.();
    if (!wasRestoring) {
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 255;
    }
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

  _removeStageActor(actor, relayout = true, fallbackMetaWindow = null) {
    let metaWindow =
      fallbackMetaWindow ?? actor?.meta_window ?? actor?.get_meta_window?.();
    this._disconnectStageActorSignals(actor, metaWindow);
    this._destroyWindowIconActor(actor);
    this._stopWindowAnimation(actor);
    let entry = this._stageEntries.get(actor);
    entry ??= this._restoringStageEntries?.get(actor);
    if (entry === this._stageHoverEntry) this._clearStageHover();
    if (entry) this._destroyStageSurfaces(entry);
    this._stageEntries.delete(actor);
    this._restoringStageEntries?.delete(actor);
    this._stageOrder = this._stageOrder.filter((item) => item !== actor);
    this._windowActors?.delete(actor);
    this._pendingStageWindows?.delete(metaWindow);
    this._restoringWindows?.delete(metaWindow);
    this._pendingRestoreTargets?.delete(metaWindow);
    this._pendingStageInsertIndexes?.delete(metaWindow);
    this._dockIconSourceActors?.delete(metaWindow);
    if (this._stagePointer?.entry === entry) this._clearStagePointer();
    if (relayout) this._relayoutStage(true);
    this._queueStageAutoHideCheck();
  }

  _removeStageMetaWindow(metaWindow, relayout = true) {
    if (!metaWindow) return false;

    let removed = false;
    for (let [actor, entry] of [...(this._stageEntries ?? [])]) {
      if (entry?.metaWindow !== metaWindow) continue;

      this._removeStageActor(actor, false, metaWindow);
      removed = true;
    }

    this._pendingStageWindows?.delete(metaWindow);
    this._pendingRestoreTargets?.delete(metaWindow);
    this._pendingStageInsertIndexes?.delete(metaWindow);
    this._restoringWindows?.delete(metaWindow);
    this._dockIconSourceActors?.delete(metaWindow);

    if (removed && relayout) this._relayoutStage(true);
    if (removed) this._queueStageAutoHideCheck();
    return removed;
  }

  _unstageActor(actor, relayout = true) {
    if (!actor) return;

    let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
    let entry = this._stageEntries.get(actor);
    if (entry) this._destroyStageSurfaces(entry);

    this._disconnectStageActorSignals(actor, metaWindow);
    this._destroyWindowIconActor(actor);
    this._stageEntries.delete(actor);
    this._restoringStageEntries?.delete(actor);
    this._stageOrder = this._stageOrder.filter((item) => item !== actor);
    this._windowActors?.delete(actor);
    this._restoringWindows?.delete(metaWindow);
    this._pendingRestoreTargets?.delete(metaWindow);
    this._pendingStageInsertIndexes?.delete(metaWindow);
    this._stopWindowAnimation(actor);

    actor.remove_all_transitions?.();
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.scale_x = 1;
    actor.scale_y = 1;
    actor.opacity = 255;
    this._setStageVisual(actor, false);
    actor.set_pivot_point?.(0, 0);

    if (relayout) this._relayoutStage(true);
    this._queueStageAutoHideCheck();
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

    let targetX = target.x - this._getStageOffsetX();
    return (
      target.y < monitor.y + monitor.height &&
      target.y + target.height + STAGE_INFO_ROW_HEIGHT > monitor.y &&
      targetX < monitor.x + monitor.width &&
      targetX + target.width > monitor.x
    );
  }

  _relayoutStage(
    animate,
    duration = stageOn_duration_minimize,
    cubic = stageOn_cubic_minimize,
    stageVisibilityTransition = false,
  ) {
    let monitor = Main.layoutManager.primaryMonitor;
    let area = this._getStageArea(monitor);
    if (!monitor || !area) return;

    let items = [];
    let baseHeight = 0;
    for (let actor of this._stageOrder) {
      let entry = this._stageEntries.get(actor);
      if (
        !entry?.actor ||
        entry.actor.is_destroyed?.() ||
        entry.state === "restoring"
      )
        continue;

      let geometry = this._getStageGeometry(entry.actor);
      if (!geometry) return;

      items.push({ actor, entry, geometry });
      baseHeight += geometry.height + STAGE_INFO_ROW_HEIGHT;
    }

    if (items.length > 1) baseHeight += STAGE_GAP * (items.length - 1);

    let fitScale = Math.min(1, area.height / Math.max(1, baseHeight));
    let overflowScale =
      fitScale < STAGE_MIN_SCROLL_SCALE ? STAGE_MIN_SCROLL_SCALE : fitScale;
    let contentHeight = items.reduce(
      (sum, item) =>
        sum + item.geometry.height * overflowScale + STAGE_INFO_ROW_HEIGHT,
      0,
    );
    if (items.length > 1) contentHeight += STAGE_GAP * (items.length - 1);

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

    let visibleDelayIndex = 0;
    for (let { entry, geometry } of items) {
      let scale = geometry.scale * overflowScale;
      let height = geometry.height * overflowScale;
      let width = geometry.width * overflowScale;
      let target = {
        x: area.x + STAGE_LEFT_OFFSET + this._getStageOffsetX(),
        y,
        width,
        height,
        scale,
      };
      entry.target = target;
      let targetVisible = this._isStageTargetVisible(target);
      let delay =
        stageVisibilityTransition && targetVisible
          ? visibleDelayIndex++ * STAGE_SHOW_HIDE_DELAY_RATIO
          : 0;
      this._moveActorToStage(
        entry,
        target,
        animate,
        duration,
        cubic,
        stageVisibilityTransition,
        delay,
        targetVisible,
      );
      this._syncStageHitActor(entry, target);
      y += height + STAGE_INFO_ROW_HEIGHT + STAGE_GAP;
    }

    let activeActors = new Set(items.map((item) => item.actor));
    for (let actor of [...(this._stageHitActors?.keys?.() ?? [])]) {
      if (!activeActors.has(actor)) this._destroyStageHitActor(actor);
    }

    this._purgeOrphanStageSurfaces();
    this._updateCoverLayer();
  }

  _moveActorToStage(
    entry,
    target,
    animate,
    duration = stageOn_duration_minimize,
    cubic = stageOn_cubic_minimize,
    stageVisibilityTransition = false,
    delay = 0,
    targetVisible = this._isStageTargetVisible(target),
  ) {
    if (entry.state === "minimizing") {
      this._moveWindowActorToStage(entry, target, animate, duration, cubic);
      return;
    }

    if (this._isDraggingStageEntry(entry)) {
      this._updateStageShadow(entry, target, false);
      this._syncStageStack(entry);
      return;
    }

    let actor = entry.shadow;
    if (!actor || actor.is_destroyed?.()) return;

    let deferStageAnimation = stageVisibilityTransition && delay > 0;
    if (!deferStageAnimation) this._stopWindowAnimation(actor);
    this._stopWindowAnimation(entry.clone);
    this._stopWindowAnimation(entry.mirror);
    this._stopWindowAnimation(entry.mirrorRotate);
    if (!deferStageAnimation) actor.remove_all_transitions?.();
    if (!stageVisibilityTransition) {
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.opacity = 255;
    }
    actor.visible = targetVisible;
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
      actor.set_position(
        target.x,
        this._stageHidden ? target.y + target.height / 2 : target.y,
      );
      actor.set_scale(this._stageHidden ? 0 : 1, this._stageHidden ? 0 : 1);
      actor.opacity = 255;
      this._setStageVisual(actor, true);
      return;
    }

    let targetScale = stageVisibilityTransition && this._stageHidden ? 0 : 1;
    let targetY =
      stageVisibilityTransition && this._stageHidden
        ? target.y + target.height / 2
        : target.y;
    if (
      stageVisibilityTransition &&
      !this._stageHidden &&
      (actor.scale_x ?? 1) < 0.01
    )
      actor.set_position?.(target.x, target.y + target.height / 2);
    if (stageVisibilityTransition) actor.opacity = 255;

    this._animateActor(
      actor,
      {
        x: target.x,
        y: targetY,
        scale: targetScale,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration,
        cubic,
        delay,
        deferStartUntilDelay: stageVisibilityTransition,
        opacityDelay: stageVisibilityTransition ? 0 : minimizeOpacityDelay,
        opacityDuration: stageVisibilityTransition
          ? duration
          : minimizeOpacityIcon,
        onUpdate: (surface) => {
          this._syncStageSourceActor(entry, target, surface);
          this._syncStageCoverLayer();
        },
        onComplete: () => {
          this._syncStageSourceActor(entry, target, actor);
          if (this._stageHidden) actor.hide?.();
          this._syncStageCoverLayer();
        },
      },
    );
  }

  _moveWindowActorToStage(
    entry,
    target,
    animate,
    duration = stageOn_duration_minimize,
    cubic = stageOn_cubic_minimize,
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
    let stageTargetY = this._stageHidden
      ? target.y + target.height / 2
      : target.y;
    let stageTargetScale = this._stageHidden ? 0 : target.scale;
    let translationY = stageTargetY - y;

    if (!animate) {
      this._stopWindowAnimation(actor);
      actor.translation_x = translationX;
      actor.translation_y = translationY;
      actor.scale_x = stageTargetScale;
      actor.scale_y = stageTargetScale;
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
        scale: stageTargetScale,
        opacity: 255,
        rotationY: 0,
      },
      {
        duration,
        cubic,
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
    let startX = startState?.x ?? target.x;
    let startY = startState?.y ?? target.y;
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

    drag.mode = "stage-animating";
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
        onUpdate: (surface, eased) => {
          let pointerX = drag.lockX ?? drag.lastX;
          let pointerY = drag.lockY ?? drag.lastY;
          let liveTarget = this._getPointerStageTarget(
            drag,
            entry,
            pointerX,
            pointerY,
          );
          entry.target = liveTarget;
          surface.set_position(
            startX + (liveTarget.x - startX) * eased,
            startY + (liveTarget.y - startY) * eased,
          );
          surface.set_scale(
            startScale + (1 - startScale) * eased,
            startScale + (1 - startScale) * eased,
          );
          this._syncStageSourceActor(entry, liveTarget, surface);
        },
        onComplete: () => {
          let pointerX = drag.lockX ?? drag.lastX;
          let pointerY = drag.lockY ?? drag.lastY;
          let target = this._getPointerStageTarget(
            drag,
            entry,
            pointerX,
            pointerY,
          );
          entry.target = target;
          entry.shadow.set_position(target.x, target.y);
          entry.shadow.set_scale(1, 1);
          this._syncStageSourceActor(entry, target, entry.shadow);
          if (this._stagePointer !== drag) return;

          drag.mode = "stage";
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

          if (drag.releaseAfterStage) {
            this._setStageEntryActive(entry, false);
            this._clearStagePointer();
            this._relayoutStage(true, drag_duration);
            return;
          }

          this._setStageEntryActive(entry, true);
          if (this._isInStageEdge(drag.lastX, drag.lastY))
            this._moveDraggedStageEntry(drag, drag.lastX, drag.lastY);
        },
      },
    );
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
    else {
      this._applyStageHiddenEntryVisual(entry);
      this._updateCoverLayer();
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
      scale: entry.target.scale * (source.scale_x ?? 1),
    };
  }

  _restoreStageEntry(entry, options = {}) {
    let { actor, metaWindow, target } = entry;
    if (!actor || !metaWindow) return;
    if (!this._isLiveMetaWindow(metaWindow)) {
      this._removeStageActor(actor, true, metaWindow);
      return;
    }
    if (this._restoringWindows.has(metaWindow)) return;

    if (
      (options.activate ?? true) &&
      this._isMetaWindowOnOtherWorkspace(metaWindow)
    ) {
      if (this._stagePointer?.entry === entry) this._clearStagePointer();
      this._activateStageWindowWorkspace(metaWindow);
      return;
    }

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

    this._activateStageWindowWorkspace(metaWindow);
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
    if (!this._isLiveMetaWindow(metaWindow)) {
      this._removeStageActor(actor, true, metaWindow);
      return;
    }

    if (this._isMetaWindowOnOtherWorkspace(metaWindow)) {
      // A dock activation can emit "unminimize" before Mutter has switched to
      // the window's workspace. At this point `actor` still carries the Stage
      // thumbnail transform. Completing the shell request here leaves an
      // interactive, but invisible, window at that transformed position.
      //
      // Match the overview escape path: remove the Stage ownership first, then
      // reset and complete only after the target workspace becomes active.
      this._unstageActor(actor);
      this._pendingStageWindows?.delete(metaWindow);
      this._pendingRestoreTargets?.delete(metaWindow);
      this._pendingStageInsertIndexes?.delete(metaWindow);
      this._restoringWindows?.delete(metaWindow);
      this._finishStageOffUnminimizeWithoutAnimation(actor, true);
      return;
    }

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

    this._activateStageWindowWorkspace(metaWindow);
    if (!pendingRestore && this._stageMode && !this._restoringAllStageWindows)
      this._minimizeVisibleWindowsExcept(metaWindow, replaceIndex);

    this._pendingRestoreTargets.delete(metaWindow);
    this._restoringWindows.add(metaWindow);
    if (entry) {
      entry.state = "restoring";
      this._restoringStageEntries?.set(entry.actor, entry);
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

  _finishStageActorRestore(actor, metaWindow, entry, activate) {
    this._restoringWindows.delete(metaWindow);
    this._pendingRestoreTargets.delete(metaWindow);
    this._restoringStageEntries?.delete(actor);
    if (entry) this._destroyStageSurfaces(entry);

    if (actor && !actor.is_destroyed?.()) {
      this._resetWindowActor(actor);
      this._completeUnminimize(actor);
    }

    if (activate) this._activateStageMetaWindow(metaWindow);
    this._updateCoverLayer();
    this._queueStageAutoHideCheck();
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

    if (
      dragInfo.returnToStage ||
      this._isInStageEdge(dragInfo.lastX, dragInfo.lastY)
    ) {
      if (entry) this._destroyStageSurfaces(entry);
      this._restoringStageEntries?.delete(actor);
      this._restoringWindows.delete(metaWindow);
      this._pendingRestoreTargets.delete(metaWindow);
      this._completeUnminimize(actor);
      this._stageDraggedWindow(dragInfo, dragInfo.lastX, dragInfo.lastY);
      this._relayoutStage(true, drag_duration);
      return;
    }

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
        allowOffstage: true,
        onCancel: () => {
          this._finishStageActorRestore(actor, metaWindow, entry, false);
          if (this._stagePointer === dragInfo) this._clearStagePointer();
        },
        onComplete: () => {
          this._finishStageActorRestore(actor, metaWindow, entry, false);
          this._raiseWindowActor(actor);

          dragInfo.mode = "window";
          dragInfo.restoreTarget = null;
          if (this._stagePointer === dragInfo && !dragInfo.released) {
            dragInfo.activateOnRelease = true;
            this._moveDraggedWindow(dragInfo, dragInfo.lastX, dragInfo.lastY);
          } else {
            this._activateStageMetaWindow(metaWindow);
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
        allowOffstage: true,
        onCancel: () =>
          this._finishStageActorRestore(actor, metaWindow, entry, activate),
        onComplete: () => {
          this._finishStageActorRestore(actor, metaWindow, entry, activate);
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
      if (!metaWindow) continue;
      if (metaWindow === exceptMetaWindow) continue;
      if (this._pendingStageWindows.has(metaWindow)) continue;
      if (this._stageEntries.has(actor)) continue;
      if (metaWindow.minimized) continue;
      if (!this._isStageWindow(metaWindow)) continue;

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
      let progressedCubic = _getProgressedCubic(CUBIC_BEZIER, DURATION);
      let frameId = 0;

      frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_INTERVAL, () => {
        let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        let eased = _progressFromCubicTable(progressedCubic, elapsed);
        let inv = 1 - eased;

        icon.translation_x = fromX * inv;
        icon.translation_y = fromY * inv;
        icon.scale_x = 1 + (fromScale - 1) * inv;
        icon.scale_y = 1 + (fromScale - 1) * inv;
        icon.opacity = Math.clamp(Math.round(255 * eased), 0, 255);

        if (elapsed < DURATION) return GLib.SOURCE_CONTINUE;

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
};
