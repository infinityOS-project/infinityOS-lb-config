"use strict";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import {
  CUBIC_BEZIER, FRAME_INTERVAL,
  STAGE_ACTIVE_DURATION, STAGE_ACTIVE_OPACITY, STAGE_DRAG_THRESHOLD,
  STAGE_EDGE_REVEAL_DELAY, STAGE_HOVER_SCALE, STAGE_INFO_LABEL_DURATION,
  STAGE_SCROLL_STEP,
  WINDOW_KEEP_ONSCREEN_DURATION, WINDOW_KEEP_ONSCREEN_PADDING, drag_duration,
} from "./config.js";
import {
  _getProgressedCubic,
  _progressFromCubicTable,
} from "./animationEngine.js";

/** Pointer capture, scrolling, drag-reorder, and drag-out behaviour. */
export const StageManagerStageScrollMixin = Base => class extends Base {
  _isInStageEdge(x, y) {
    let area = this._getShiftedStageArea(null, true);
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

  _getStageEntryHit(entry, x, y) {
    let target = this._getStageEntryVisualTarget(entry);
    if (this._pointInStageTarget(x, y, target)) return { entry, target };

    if (entry?.state !== "minimizing") return null;
    let fallbackTarget = entry.target;
    if (
      fallbackTarget !== target &&
      this._pointInStageTarget(x, y, fallbackTarget)
    )
      return { entry, target: fallbackTarget };

    return null;
  }

  _pointInStageTarget(x, y, target) {
    return (
      !!target &&
      x >= target.x &&
      x <= target.x + target.width &&
      y >= target.y &&
      y <= target.y + target.height
    );
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
    return this._getStageHitAt(x, y)?.entry ?? null;
  }

  _getStageHitAt(x, y) {
    if (!this._isInStageEdge(x, y)) return null;

    for (let includeMinimizing of [false, true]) {
      for (let i = this._stageOrder.length - 1; i >= 0; i--) {
        let entry = this._stageEntries.get(this._stageOrder[i]);
        if (
          entry?.state === "restoring" ||
          (!includeMinimizing && entry?.state === "minimizing")
        )
          continue;

        let hit = this._getStageEntryHit(entry, x, y);
        if (hit) return hit;
      }
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
    let hoverBlocked = this._isStageHoverBlocked();
    if (hoverBlocked) visible = false;

    let label = entry?.label;
    if (label && !label.is_destroyed?.()) {
      label.remove_all_transitions?.();
      if (hoverBlocked) {
        label.opacity = 0;
      } else {
        label.ease({
          opacity: visible ? 255 : 0,
          duration: STAGE_INFO_LABEL_DURATION,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      }
    }

    let shadow = entry?.shadow;
    if (!shadow || shadow.is_destroyed?.()) return;

    if (hoverBlocked) {
      shadow.remove_all_transitions?.();
      shadow.set_pivot_point?.(0, 0);
      return;
    }

    shadow.set_pivot_point?.(0.5, 0.5);
    shadow.ease({
      scaleX: visible ? STAGE_HOVER_SCALE : 1,
      scaleY: visible ? STAGE_HOVER_SCALE : 1,
      duration: STAGE_INFO_LABEL_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _updateStageHover(x, y) {
    if (this._isStageHoverBlocked()) {
      this._clearStageHoverForVisibilityTransition();
      return;
    }

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

  _isStageHoverBlocked() {
    return this._stageHidden || this._stageVisibilityTransitioning;
  }

  _clearStageHoverForVisibilityTransition() {
    let entry = this._stageHoverEntry;
    this._stageHoverEntry = null;
    if (!entry) return;

    let label = entry.label;
    if (label && !label.is_destroyed?.()) {
      label.remove_all_transitions?.();
      label.opacity = 0;
    }

    let shadow = entry.shadow;
    if (!shadow || shadow.is_destroyed?.()) return;

    shadow.remove_all_transitions?.();
    shadow.set_pivot_point?.(0, 0);
    shadow.scale_x = 1;
    shadow.scale_y = 1;
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

  _clearStageClickRetry() {
    if (!this._stageClickRetryId) return;

    GLib.Source.remove(this._stageClickRetryId);
    this._stageClickRetryId = 0;
  }

  _queueStageClickRetry(x, y, attempts = 5) {
    this._clearStageClickRetry();
    this._stageClickRetryId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        this._stageClickRetryId = 0;
        if (this._stagePointer) return GLib.SOURCE_REMOVE;

        let entry = this._getStageEntryAt(x, y);
        if (entry) {
          this._restoreStageEntry(entry);
          return GLib.SOURCE_REMOVE;
        }

        if (attempts > 1) this._queueStageClickRetry(x, y, attempts - 1);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _onStageButtonPress(event) {
    if (event.get_button?.() !== Clutter.BUTTON_PRIMARY)
      return Clutter.EVENT_PROPAGATE;

    let [x, y] = event.get_coords();
    return this._beginStagePointerAt(x, y);
  }

  _onStageTouchEvent(event) {
    let type = event.type();
    let [x, y] = event.get_coords();

    if (type === Clutter.EventType.TOUCH_BEGIN)
      return this._beginStagePointerAt(x, y);

    if (!this._stagePointer) return Clutter.EVENT_PROPAGATE;

    if (type === Clutter.EventType.TOUCH_UPDATE) {
      this._onStagePointerMotion(x, y, event);
      return Clutter.EVENT_STOP;
    }

    if (
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    ) {
      this._onStagePointerRelease(x, y, event);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _onStageInputCapturedEvent(event) {
    if (!this._stageMode || this._stagePointer) return Clutter.EVENT_PROPAGATE;

    let type = event.type();
    let [x, y] = event.get_coords?.() ?? [NaN, NaN];

    if (
      this._stageHidden &&
      this._isInStageRevealEdge(x, y) &&
      (type === Clutter.EventType.MOTION ||
        type === Clutter.EventType.BUTTON_PRESS ||
        type === Clutter.EventType.TOUCH_BEGIN)
    ) {
      this._queueStageEdgeReveal(
        type === Clutter.EventType.BUTTON_PRESS ? 0 : STAGE_EDGE_REVEAL_DELAY,
      );
      return Clutter.EVENT_STOP;
    }

    let hit = this._getStageHitAt(x, y);
    if (!hit) {
      if (type === Clutter.EventType.MOTION && this._isInStageEdge(x, y))
        this._clearStageHover();
      return Clutter.EVENT_PROPAGATE;
    }

    if (type === Clutter.EventType.MOTION) {
      this._clearStageAutoHideCheck();
      this._updateStageHover(x, y);
      return Clutter.EVENT_STOP;
    }

    if (type === Clutter.EventType.BUTTON_PRESS) {
      if (event.get_button?.() === Clutter.BUTTON_PRIMARY)
        return this._beginStagePointerAt(x, y);
      return Clutter.EVENT_STOP;
    }

    if (type === Clutter.EventType.TOUCH_BEGIN)
      return this._beginStagePointerAt(x, y);

    if (type === Clutter.EventType.SCROLL) return this._onStageScroll(event);

    if (
      type === Clutter.EventType.BUTTON_RELEASE ||
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    )
      return Clutter.EVENT_STOP;

    return Clutter.EVENT_PROPAGATE;
  }

  _beginStagePointerAt(x, y) {
    this._clearStageClickRetry();
    this._clearStageAutoHideCheck();
    this._clearStageEdgeReveal();

    let hit = this._getStageHitAt(x, y);

    if (!hit) {
      this._queueStageClickRetry(x, y);
      return Clutter.EVENT_STOP;
    }

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
    if (
      type === Clutter.EventType.MOTION ||
      type === Clutter.EventType.TOUCH_UPDATE
    ) {
      let [x, y] = event.get_coords();
      this._onStagePointerMotion(x, y, event);
      return Clutter.EVENT_STOP;
    }

    if (
      type === Clutter.EventType.BUTTON_RELEASE ||
      type === Clutter.EventType.TOUCH_END ||
      type === Clutter.EventType.TOUCH_CANCEL
    ) {
      let [x, y] = event.get_coords();
      this._onStagePointerRelease(x, y, event);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_STOP;
  }

  _onStagePointerMotion(x, y, event) {
    let drag = this._stagePointer;
    if (!drag) return;
    if (drag.released) return;

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

    if (drag.mode === "stage-animating") {
      if (!this._isInStageEdge(x, y)) {
        drag.mode = "stage";
        this._startStageDragOut(drag, x, y);
      }
      return;
    }

    if (drag.mode === "restore-pending" || drag.mode === "restore-animating") {
      if (this._isInStageEdge(x, y)) drag.returnToStage = true;
      return;
    }

    if (drag.mode === "stage-pending") return;
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
      if (this._isInStageEdge(x, y)) {
        drag.returnToStage = true;
        drag.releaseAfterStage = true;
        return;
      }

      this._clearStagePointer();
      return;
    }

    if (drag.mode === "stage-pending") {
      drag.releaseAfterStage = true;
      return;
    }

    if (drag.mode === "stage-animating") {
      drag.releaseAfterStage = true;
      drag.lockX = x;
      drag.lockY = y;
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
    let progressedCubic = _getProgressedCubic(
      CUBIC_BEZIER,
      WINDOW_KEEP_ONSCREEN_DURATION,
    );
    let frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        if (!metaWindow || metaWindow.minimized) {
          this._windowPushIds.delete(metaWindow);
          return GLib.SOURCE_REMOVE;
        }

        let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
        let eased = _progressFromCubicTable(progressedCubic, elapsed);
        metaWindow.move_frame(
          true,
          Math.round(startX + (targetX - startX) * eased),
          Math.round(startY + (targetY - startY) * eased),
        );

        if (elapsed < WINDOW_KEEP_ONSCREEN_DURATION)
          return GLib.SOURCE_CONTINUE;

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
    drag.stageMinimizeStart = this._getActorVisualState(drag.actor) ?? {
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

};
