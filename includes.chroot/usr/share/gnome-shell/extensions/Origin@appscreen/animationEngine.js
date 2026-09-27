"use strict";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import {
  CUBIC_BEZIER,
  DURATION,
  FRAME_INTERVAL,
  PROGRESSED_CUBIC_STEP_MS,
  PROGRESSED_CUBIC_MIN_STEPS,
  WINDOW_KEEP_ONSCREEN_DURATION,
  drag_duration,
  other_cubic,
  other_duration,
  other_duration_2,
  stageOff_cubic_minimize,
  stageOff_cubic_uminimize,
  stageOff_duration_minimize,
  stageOff_duration_unminimize,
  stageOn_cubic_minimize,
  stageOn_cubic_uminimize,
  stageOn_duration_minimize,
  stageOn_duration_unminimize,
} from "./config.js";

export let currentProgressedCubicMinimize = null;
export let currentProgressedCubicUnminimize = null;
export let currentProgressedCubicMinimizeDuration = 0;
export let currentProgressedCubicUnminimizeDuration = 0;
export let currentProgressedCubicMinimizeSource = null;
export let currentProgressedCubicUnminimizeSource = null;

const _progressedCubicCache = new Map();

export function _cubicCoord(a, b, t) {
  let inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

export function _progressedCubicKey(cubic, duration) {
  return `${Math.ceil(duration / PROGRESSED_CUBIC_STEP_MS)}:${cubic[0]},${cubic[1]},${cubic[2]},${cubic[3]}`;
}

export function _createProgressedCubic(cubic, duration) {
  let maxIndex = Math.max(1, Math.ceil(duration / PROGRESSED_CUBIC_STEP_MS));
  let table = new Float32Array(maxIndex + 1);
  let x1 = cubic[0];
  let y1 = cubic[1];
  let x2 = cubic[2];
  let y2 = cubic[3];
  let steps = Math.max(PROGRESSED_CUBIC_MIN_STEPS, maxIndex * 8);
  let lastIndex = 0;
  let lastY = 0;

  table[0] = 0;
  for (let step = 1; step <= steps; step++) {
    let t = step / steps;
    let x = _cubicCoord(x1, x2, t);
    let y = _cubicCoord(y1, y2, t);
    let index = Math.round(Math.clamp(x, 0, 1) * maxIndex);

    if (index > lastIndex) {
      let span = index - lastIndex;
      for (let i = 1; i <= span; i++)
        table[lastIndex + i] = lastY + (y - lastY) * (i / span);

      lastIndex = index;
    }

    lastY = y;
  }

  if (lastIndex < maxIndex) {
    let span = maxIndex - lastIndex;
    for (let i = 1; i <= span; i++)
      table[lastIndex + i] = lastY + (1 - lastY) * (i / span);
  }

  table[maxIndex] = 1;
  return table;
}

export function _getProgressedCubic(cubic, duration) {
  let key = _progressedCubicKey(cubic, duration);
  let table = _progressedCubicCache.get(key);
  if (!table) {
    table = _createProgressedCubic(cubic, duration);
    _progressedCubicCache.set(key, table);
  }

  return table;
}

export function _progressFromCubicTable(table, elapsedMs) {
  let index = Math.round(elapsedMs / PROGRESSED_CUBIC_STEP_MS);
  if (index <= 0) return table[0];
  if (index >= table.length) return table[table.length - 1];
  return table[index];
}

export function _updateCurrentProgressedCubics(stageMode) {
  currentProgressedCubicMinimizeSource = stageMode
    ? stageOn_cubic_minimize
    : stageOff_cubic_minimize;
  currentProgressedCubicUnminimizeSource = stageMode
    ? stageOn_cubic_uminimize
    : stageOff_cubic_uminimize;
  currentProgressedCubicMinimizeDuration = stageMode
    ? stageOn_duration_minimize
    : stageOff_duration_minimize;
  currentProgressedCubicUnminimizeDuration = stageMode
    ? stageOn_duration_unminimize
    : stageOff_duration_unminimize;
  currentProgressedCubicMinimize = _getProgressedCubic(
    currentProgressedCubicMinimizeSource,
    currentProgressedCubicMinimizeDuration,
  );
  currentProgressedCubicUnminimize = _getProgressedCubic(
    currentProgressedCubicUnminimizeSource,
    currentProgressedCubicUnminimizeDuration,
  );
}

export function _prewarmProgressedCubics() {
  _updateCurrentProgressedCubics(false);
  _getProgressedCubic(stageOn_cubic_minimize, stageOn_duration_minimize);
  _getProgressedCubic(stageOn_cubic_uminimize, stageOn_duration_unminimize);
  _getProgressedCubic(stageOn_cubic_minimize, drag_duration);
  _getProgressedCubic(other_cubic, other_duration);
  _getProgressedCubic(other_cubic, other_duration_2);
  _getProgressedCubic(CUBIC_BEZIER, DURATION);
  _getProgressedCubic(CUBIC_BEZIER, WINDOW_KEEP_ONSCREEN_DURATION);
}

/** Reusable per-actor animation primitives. */
export const AnimationEngineMixin = Base => class extends Base {
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

  _animateActor(actor, target, params = {}) {
    if (!actor || actor.is_destroyed?.()) return 0;

    let delay = params.delay ?? 0;
    if (delay > 0 && params.deferStartUntilDelay) {
      this._clearDelayedAnimation(actor);
      let delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        this._delayedAnimationIds?.delete(actor);
        if (!actor.is_destroyed?.())
          this._animateActor(actor, target, {
            ...params,
            delay: 0,
            deferStartUntilDelay: false,
          });
        return GLib.SOURCE_REMOVE;
      });
      this._delayedAnimationIds?.set(actor, delayId);
      return delayId;
    }

    this._stopWindowAnimation(actor);
    actor.remove_all_transitions?.();

    let token = this._nextAnimationToken(actor);
    let duration = params.duration ?? stageOn_duration_minimize;
    let cubic = params.cubic ?? stageOn_cubic_minimize;
    let progressedCubic =
      params.progressedCubic ?? _getProgressedCubic(cubic, duration);
    let startTime = GLib.get_monotonic_time() + delay * 1000;
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
    let opacityUsesMainProgress =
      opacityDelay === 0 && opacityDuration === duration;
    let opacityProgressedCubic = opacityUsesMainProgress
      ? progressedCubic
      : _getProgressedCubic(cubic, opacityDuration);
    let opacityDelta = to.opacity - from.opacity;
    let shouldAnimateOpacity = Math.abs(opacityDelta) >= 1;
    let onUpdate = params.onUpdate;
    let onComplete = params.onComplete;

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
          let eased = _progressFromCubicTable(progressedCubic, elapsed);
          let opacityEased = eased;
          if (shouldAnimateOpacity && !opacityUsesMainProgress) {
            opacityEased = _progressFromCubicTable(
              opacityProgressedCubic,
              elapsed - opacityDelay,
            );
          }

          let x = from.x + (to.x - from.x) * eased;
          let y = from.y + (to.y - from.y) * eased;
          if (actor.set_position) actor.set_position(x, y);
          else {
            actor.x = x;
            actor.y = y;
          }
          actor.scale_x = from.scaleX + (to.scaleX - from.scaleX) * eased;
          actor.scale_y = from.scaleY + (to.scaleY - from.scaleY) * eased;
          if (shouldAnimateOpacity)
            actor.opacity = Math.clamp(
              Math.round(from.opacity + opacityDelta * opacityEased),
              0,
              255,
            );
          this._setRotationY(
            actor,
            from.rotationY + (to.rotationY - from.rotationY) * eased,
          );
          onUpdate?.(actor, eased);

          if (elapsed < duration) return GLib.SOURCE_CONTINUE;

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
          onUpdate?.(actor, 1);
          onComplete?.();
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
    let progressedCubic =
      params.progressedCubic ?? _getProgressedCubic(cubic, duration);
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
    let opacityUsesMainProgress =
      opacityDelay === 0 && opacityDuration === duration;
    let opacityProgressedCubic = opacityUsesMainProgress
      ? progressedCubic
      : _getProgressedCubic(cubic, opacityDuration);
    let opacityDelta = to.opacity - from.opacity;
    let shouldAnimateOpacity = Math.abs(opacityDelta) >= 1;
    let allowOffstage = params.allowOffstage;
    let onUpdate = params.onUpdate;
    let onComplete = params.onComplete;
    let onCancel = params.onCancel;

    let frameId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      FRAME_INTERVAL,
      () => {
        try {
          if (
            !this._isCurrentAnimation(actor, token) ||
            actor.is_destroyed?.() ||
            (!allowOffstage && !actor.get_stage?.())
          ) {
            this._windowAnimationIds.delete(actor);
            onCancel?.(actor);
            return GLib.SOURCE_REMOVE;
          }

          let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          let eased = _progressFromCubicTable(progressedCubic, elapsed);
          let opacityEased = eased;
          if (shouldAnimateOpacity && !opacityUsesMainProgress) {
            opacityEased = _progressFromCubicTable(
              opacityProgressedCubic,
              elapsed - opacityDelay,
            );
          }

          actor.translation_x =
            from.translationX + (to.translationX - from.translationX) * eased;
          actor.translation_y =
            from.translationY + (to.translationY - from.translationY) * eased;
          actor.scale_x = from.scaleX + (to.scaleX - from.scaleX) * eased;
          actor.scale_y = from.scaleY + (to.scaleY - from.scaleY) * eased;
          if (shouldAnimateOpacity)
            actor.opacity = Math.clamp(
              Math.round(from.opacity + opacityDelta * opacityEased),
              0,
              255,
            );
          this._setRotationY(
            actor,
            from.rotationY + (to.rotationY - from.rotationY) * eased,
          );
          onUpdate?.(actor, eased);

          if (elapsed < duration) return GLib.SOURCE_CONTINUE;

          this._windowAnimationIds.delete(actor);
          actor.translation_x = to.translationX;
          actor.translation_y = to.translationY;
          actor.scale_x = to.scaleX;
          actor.scale_y = to.scaleY;
          actor.opacity = Math.clamp(to.opacity, 0, 255);
          this._setRotationY(actor, to.rotationY);
          onUpdate?.(actor, 1);
          onComplete?.();
          return GLib.SOURCE_REMOVE;
        } catch {
          this._windowAnimationIds.delete(actor);
          onCancel?.(actor);
          return GLib.SOURCE_REMOVE;
        }
      },
    );

    this._windowAnimationIds.set(actor, frameId);
    return token;
  }

};
