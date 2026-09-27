"use strict";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import Meta from "gi://Meta";
import St from "gi://St";
import {
  FALLBACK_ICON_SIZE,
  FRAME_INTERVAL,
  ICON_TRACKING_SMOOTH,
  minimizeOpacityDelay,
  minimizeOpacityIcon,
  other_cubic,
  other_duration,
  other_duration_2,
  unminimizeOpacityDelayIcon,
  unminimizeOpacityIcon,
} from "./config.js";
import {
  _getProgressedCubic,
  _progressFromCubicTable,
  currentProgressedCubicMinimize,
  currentProgressedCubicUnminimize,
  currentProgressedCubicMinimizeDuration,
  currentProgressedCubicUnminimizeDuration,
  currentProgressedCubicMinimizeSource,
  currentProgressedCubicUnminimizeSource,
} from "./animationEngine.js";
import { _finiteOr } from "./helper.js";

/** Window-to-dock-icon minimize and reverse unminimize animation. */
export const RemakeMinimizeAnimMixin = (Base) =>
  class extends Base {
    _connectWindowAnimations() {
      if (this._minimizeSignal || this._unminimizeSignal) return;

      this._originalShouldAnimateActor = Main.wm._shouldAnimateActor;
      Main.wm._shouldAnimateActor = (actor, types) => {
        let stack = new Error().stack;
        if (
          stack?.includes("_destroyWindow") &&
          this._isManagedWindowActor(actor)
        ) {
          this._prepareManagedWindowDestroy(actor);
          return false;
        }

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
          if (this._stageMode) this._queueStageAutoHideCheck();

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
          if (this._stageMode) this._queueStageAutoHideCheck();

          if (!this._shouldOwnWindowAnimation(actor)) return;
          let metaWindow = actor.meta_window ?? actor.get_meta_window?.();

          if (Main.overview.visible) {
            if (this._stageEntries.has(actor)) this._unstageActor(actor);
            this._pendingStageWindows.delete(metaWindow);
            this._pendingRestoreTargets.delete(metaWindow);
            this._pendingStageInsertIndexes.delete(metaWindow);
            this._restoringWindows.delete(metaWindow);
            this._finishStageOffUnminimizeWithoutAnimation(
              actor,
              this._isMetaWindowOnOtherWorkspace(metaWindow),
            );
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

          if (this._isMetaWindowOnOtherWorkspace(metaWindow)) {
            this._finishStageOffUnminimizeWithoutAnimation(actor, true);
            return;
          }

          if (
            this._isIconAnimationActor(actor) &&
            this._isWorkspaceJumpUnsafe()
          ) {
            this._finishStageOffUnminimizeWithoutAnimation(actor, true);
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
        if (this._stageMode) this._queueStageAutoHideCheck();
        if (!this._stageMode || !this._isStageActor(actor)) return;

        let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
        this._minimizeVisibleWindowsExcept(metaWindow);
        this._queueStageAutoHideCheck();
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
        Main.wm._shellwm.completed_unminimize =
          this._originalCompletedUnminimize;
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

    _isManagedWindowActor(actor) {
      let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
      return (
        this._windowAnimationIds?.has(actor) ||
        this._windowActors?.has(actor) ||
        this._windowIconActors?.has(actor) ||
        this._stageEntries?.has(actor) ||
        this._restoringStageEntries?.has(actor) ||
        this._pendingStageWindows?.has(metaWindow) ||
        this._pendingRestoreTargets?.has(metaWindow) ||
        this._restoringWindows?.has(metaWindow)
      );
    }

    _prepareManagedWindowDestroy(actor) {
      if (!actor) return;

      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      let entry =
        this._stageEntries?.get(actor) ??
        this._restoringStageEntries?.get(actor);

      this._clearWorkspaceUnminimizeWait(actor);
      this._destroyWindowIconActor(actor, true);
      this._stopWindowAnimation(actor);

      if (entry) this._removeStageActor(actor, true, metaWindow);
      else {
        this._disconnectStageActorSignals(actor, metaWindow);
        this._windowActors?.delete(actor);
      }

      this._pendingStageWindows?.delete(metaWindow);
      this._pendingRestoreTargets?.delete(metaWindow);
      this._pendingStageInsertIndexes?.delete(metaWindow);
      this._restoringWindows?.delete(metaWindow);
      this._dockIconSourceActors?.delete(metaWindow);
      if (
        this._stagePointer?.actor === actor ||
        this._stagePointer?.metaWindow === metaWindow
      )
        this._clearStagePointer();

      actor.remove_all_transitions?.();
      actor.translation_x = 0;
      actor.translation_y = 0;
      actor.scale_x = 1;
      actor.scale_y = 1;
      actor.opacity = 0;
      this._setStageVisual(actor, false);
      actor.hide?.();
    }

    _getWindowIcon(actor) {
      let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
      if (!metaWindow) return null;

      let dockIcon = this._findWindowDockIcon(actor);
      if (dockIcon) {
        let target = this._normalizeIcon(dockIcon, actor);
        if (target) return target;
      }

      let [success, icon] = metaWindow.get_icon_geometry();
      if (success) {
        let target = this._normalizeIcon(icon, actor);
        if (target) return target;
      }

      let monitor = Main.layoutManager.monitors[metaWindow.get_monitor()];
      if (!monitor || !Main.overview.dash)
        return this._fallbackPointerIcon(actor);

      Main.overview.dash._redisplay?.();

      let pid = metaWindow.get_pid();
      if (pid && Main.overview.dash._box) {
        for (let dashElement of Main.overview.dash._box.get_children()) {
          let app = dashElement.child?._delegate?.app;
          let pids = app?.get_pids?.();
          if (!pids?.includes(pid)) continue;

          let target = this._getIconTargetFromActor(
            dashElement.child ?? dashElement,
          );
          if (target) {
            let normalizedTarget = this._normalizeIcon(target, actor);
            if (normalizedTarget) return normalizedTarget;
          }
        }
      }

      return this._fallbackPointerIcon(actor);
    }

    _findWindowDockIcon(actor) {
      let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
      if (!metaWindow) return null;

      let app = this._getStageWindowApp(metaWindow);
      let pid = metaWindow.get_pid?.();
      let cachedSourceActor = this._dockIconSourceActors.get(metaWindow);
      let cachedTarget = this._getIconTargetFromActor(cachedSourceActor);
      if (cachedTarget) return cachedTarget;

      for (let panel of this._getDashToPanelPanels()) {
        let appIcons = [];
        try {
          appIcons = panel.taskbar?._getAppIcons?.() ?? [];
        } catch {}

        for (let appIcon of appIcons) {
          if (!this._dockAppIconMatchesWindow(appIcon, app, metaWindow, pid))
            continue;

          let target = this._getIconTargetFromActor(appIcon);
          if (target) {
            this._dockIconSourceActors.set(metaWindow, target.sourceActor);
            return target;
          }
        }
      }

      if (Main.overview.dash?._box) {
        Main.overview.dash._redisplay?.();

        for (let dashElement of Main.overview.dash._box.get_children()) {
          let appIcon = dashElement.child?._delegate ?? dashElement.child;
          if (!this._dockAppIconMatchesWindow(appIcon, app, metaWindow, pid))
            continue;

          let target = this._getIconTargetFromActor(
            dashElement.child ?? dashElement,
          );
          if (target) {
            this._dockIconSourceActors.set(metaWindow, target.sourceActor);
            return target;
          }
        }
      }

      return null;
    }

    _getDashToPanelPanels() {
      let panels = [];
      let seen = new Set();
      let addPanel = (panel) => {
        if (!panel || seen.has(panel)) return;
        seen.add(panel);
        panels.push(panel);
      };

      for (let panel of global.dashToPanel?.panels ?? []) addPanel(panel);

      addPanel(Main.panel?._delegate);

      let scanActorTree = (actor, depth = 0) => {
        if (!actor || depth > 5) return;

        addPanel(actor._delegate);
        for (let child of actor.get_children?.() ?? [])
          scanActorTree(child, depth + 1);
      };

      scanActorTree(global.stage);
      scanActorTree(Main.layoutManager?.uiGroup);
      scanActorTree(Main.layoutManager?.panelBox);

      return panels.filter((panel) => panel?.taskbar);
    }

    _dockAppIconMatchesWindow(appIcon, app, metaWindow, pid) {
      if (!appIcon) return false;
      if (appIcon.window && appIcon.window === metaWindow) return true;
      if (app && appIcon.app && appIcon.app === app) return true;

      let windows = appIcon.getAppIconInterestingWindows?.(false) ?? [];
      if (windows.includes(metaWindow)) return true;

      let pids = appIcon.app?.get_pids?.();
      if (pid && pids?.includes(pid)) return true;

      return false;
    }

    _getIconTargetFromActor(actor) {
      let sourceActor = this._findIconImageActor(actor);
      if (!sourceActor) return null;

      let geometry = this._getTransformedActorGeometry(sourceActor);
      if (!geometry) return null;

      return {
        ...geometry,
        sourceActor,
      };
    }

    _findIconImageActor(actor) {
      try {
        if (!actor || actor.is_destroyed?.()) return null;
      } catch {
        return null;
      }

      let explicitActors = [
        actor?.icon?._iconBin,
        actor?.icon?.icon,
        actor?.icon,
        actor?._dtpIconContainer,
        actor?._iconContainer,
        actor?.child?._delegate?.icon?._iconBin,
        actor?.child?._delegate?.icon?.icon,
        actor?.child?._delegate?.icon,
        actor?.child?._delegate?._dtpIconContainer,
        actor?.child?._delegate?._iconContainer,
        actor?.child,
        actor,
      ];

      for (let candidate of explicitActors) {
        let geometry = this._getTransformedActorGeometry(candidate);
        if (geometry && geometry.width >= 8 && geometry.height >= 8)
          return candidate;
      }

      let best = null;
      let bestScore = -Infinity;
      let visit = (item, depth = 0) => {
        try {
          if (!item || item.is_destroyed?.() || depth > 8) return;
        } catch {
          return;
        }

        let geometry = this._getTransformedActorGeometry(item);
        if (geometry && geometry.width >= 8 && geometry.height >= 8) {
          let ratio =
            Math.max(geometry.width, geometry.height) /
            Math.max(1, Math.min(geometry.width, geometry.height));
          if (ratio <= 2.5) {
            let name = item.constructor?.name ?? "";
            let score =
              (item instanceof St.Icon ? 100000 : 0) +
              (name.includes("Icon") ? 50000 : 0) -
              Math.abs(
                Math.max(geometry.width, geometry.height) - FALLBACK_ICON_SIZE,
              ) -
              depth * 10;
            if (score > bestScore) {
              best = item;
              bestScore = score;
            }
          }
        }

        for (let child of item.get_children?.() ?? []) visit(child, depth + 1);
      };

      visit(actor);
      return best;
    }

    _readTransformedActorGeometry(actor, out) {
      try {
        if (!actor || actor.is_destroyed?.()) return false;
        if (actor.mapped === false || actor.visible === false) return false;

        let [x, y] = actor.get_transformed_position();
        let [width, height] = actor.get_transformed_size?.() ?? [
          actor.width,
          actor.height,
        ];
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0
        )
          return false;

        out.x = x;
        out.y = y;
        out.width = width;
        out.height = height;
        return true;
      } catch {
        return false;
      }
    }

    _getTransformedActorGeometry(actor) {
      let geometry = { x: 0, y: 0, width: 0, height: 0 };
      if (this._readTransformedActorGeometry(actor, geometry)) {
        return geometry;
      } else {
        return null;
      }
    }

    _fallbackPointerIcon(actor) {
      let [x, y] = global.get_pointer?.() ?? [0, 0];
      return this._normalizeIcon(
        {
          x: _finiteOr(x, 0),
          y: _finiteOr(y, 0),
          width: 0,
          height: 0,
          zeroScale: true,
        },
        actor,
      );
    }

    _normalizeIcon(icon, actor) {
      let [windowWidth, windowHeight] = actor.get_size();
      if (
        !Number.isFinite(windowWidth) ||
        !Number.isFinite(windowHeight) ||
        windowWidth <= 0 ||
        windowHeight <= 0
      )
        return null;

      let x = Number(icon.x);
      let y = Number(icon.y);
      let iconWidth = Number(icon.width);
      let iconHeight = Number(icon.height);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(iconWidth) ||
        !Number.isFinite(iconHeight)
      )
        return null;

      if (icon.zeroScale)
        return {
          x,
          y,
          width: 0,
          height: 0,
          sourceActor: null,
        };

      if (iconWidth <= 0 || iconHeight <= 0) return null;

      let width = iconWidth;
      let height = iconHeight;

      return {
        x: x + (iconWidth - width) / 2,
        y: y + (iconHeight - height) / 2,
        width: Math.min(width, windowWidth),
        height: Math.min(height, windowHeight),
        sourceActor: icon.sourceActor ?? null,
      };
    }

    _getLiveWindowIconTarget(actor, fallbackIcon) {
      let sourceActor = fallbackIcon?.sourceActor;
      if (!sourceActor || sourceActor.is_destroyed?.()) return fallbackIcon;

      let geometry = this._getTransformedActorGeometry(sourceActor);
      if (!geometry) return fallbackIcon;

      return (
        this._normalizeIcon({ ...geometry, sourceActor }, actor) ?? fallbackIcon
      );
    }

    _createWindowIconAnimationActor(actor, icon) {
      this._destroyWindowIconActor(actor, true);

      let metaWindow = actor?.meta_window ?? actor?.get_meta_window?.();
      let size = Math.max(
        icon?.width ?? 0,
        icon?.height ?? 0,
        FALLBACK_ICON_SIZE,
      );
      let iconActor = null;

      try {
        iconActor =
          this._getStageWindowApp(metaWindow)?.create_icon_texture(size);
      } catch {}

      iconActor ??= new St.Icon({
        icon_name: "application-x-executable-symbolic",
        icon_size: size,
        reactive: false,
      });

      iconActor.reactive = false;
      iconActor.opacity = 0;
      iconActor.set_size?.(Math.max(1, icon.width), Math.max(1, icon.height));
      iconActor.set_position?.(icon.x, icon.y);
      iconActor.set_pivot_point?.(0, 0);
      iconActor._originWindowIconAnimation = true;
      iconActor._originWindowActor = actor;
      iconActor._originWindowIconReleased = false;

      let parent = this._getWindowIconAnimationLayer();
      parent.add_child(iconActor);
      this._raiseWindowIconActor(iconActor);

      this._windowIconActors.set(actor, iconActor);
      this._windowIconSurfaces.add(iconActor);
      return iconActor;
    }

    _getWindowIconAnimationLayer() {
      return Main.layoutManager?.uiGroup ?? Main.uiGroup ?? global.stage;
    }

    _raiseWindowIconActor(iconActor) {
      if (!iconActor || iconActor.is_destroyed?.()) return;

      try {
        iconActor.get_parent?.()?.set_child_above_sibling(iconActor, null);
      } catch {}
    }

    _releaseWindowIconActor(actor, iconActor) {
      if (this._windowIconActors?.get(actor) === iconActor)
        this._windowIconActors.delete(actor);

      try {
        iconActor._originWindowIconReleased = true;
      } catch {}
    }

    _destroyIconAnimationActor(
      iconActor,
      restoreDockIcon = true,
      animateDockIcon = true,
    ) {
      if (!iconActor) return;

      let originActor = null;
      try {
        originActor = iconActor._originWindowActor;
        if (this._windowIconActors?.get(originActor) === iconActor)
          this._windowIconActors.delete(originActor);
      } catch {}

      if (restoreDockIcon) {
        try {
          this._restoreDockIconForWindow(originActor, animateDockIcon);
        } catch {}
      }

      let destroyActor = () => {
        this._windowIconSurfaces?.delete(iconActor);
        try {
          this._stopWindowAnimation(iconActor);
        } catch {}
        try {
          iconActor.remove_all_transitions?.();
        } catch {}
        try {
          iconActor.get_parent?.()?.remove_child?.(iconActor);
        } catch {}
        try {
          iconActor.destroy();
        } catch {}
      };

      if (animateDockIcon && !iconActor.is_destroyed?.()) {
        try {
          this._raiseWindowIconActor(iconActor);
          this._animateActor(
            iconActor,
            { opacity: 0 },
            { scale: 0 },
            {
              duration: other_duration,
              cubic: other_cubic,
              onComplete: destroyActor,
            },
          );
          return;
        } catch {}
      }

      destroyActor();
    }

    _destroyWindowIconActor(actor, includeReleased = false) {
      let iconActor = this._windowIconActors?.get(actor);
      let iconActors = new Set();
      if (iconActor) iconActors.add(iconActor);

      this._windowIconActors.delete(actor);

      for (let surface of this._windowIconSurfaces ?? []) {
        if (surface?._originWindowActor !== actor) continue;
        if (!includeReleased && surface._originWindowIconReleased) continue;
        iconActors.add(surface);
      }

      for (let item of iconActors)
        this._destroyIconAnimationActor(item, true, false);
    }

    _hasReleasedWindowIconActor(actor) {
      for (let surface of this._windowIconSurfaces ?? []) {
        if (surface?._originWindowActor !== actor) continue;
        if (surface._originWindowIconReleased) return true;
      }

      return false;
    }

    _destroyAllWindowIconActors() {
      for (let iconActor of [...(this._windowIconSurfaces ?? [])])
        this._destroyIconAnimationActor(iconActor, true, false);

      this._windowIconActors?.clear();
      this._windowIconSurfaces?.clear();
      this._restoreAllDockIcons();
    }

    _hideDockIconForWindow(actor, dockIconActor, animate = false) {
      if (!actor || !dockIconActor || dockIconActor.is_destroyed?.()) return;

      let previousDockIcon = this._windowDockIconActors?.get(actor);
      let releasedState = null;
      if (previousDockIcon === dockIconActor)
        releasedState = this._releaseDockIconForWindow(actor);
      else if (previousDockIcon) this._restoreDockIconForWindow(actor, true);

      let state = this._hiddenDockIconActors.get(dockIconActor);
      if (!state) {
        state = {
          count: 0,
          opacity:
            releasedState?.opacity ??
            dockIconActor._originDockIconTargetOpacity ??
            dockIconActor.opacity ??
            255,
        };
        this._hiddenDockIconActors.set(dockIconActor, state);
      }

      state.count++;
      this._windowDockIconActors.set(actor, dockIconActor);
      const oldOpacityVal = dockIconActor.opacity ?? state.opacity ?? 255;
      this._animateDockIconOpacity(
        dockIconActor,
        oldOpacityVal,
        0,
        animate,
        state.opacity,
      );
    }

    _releaseDockIconForWindow(actor) {
      let dockIconActor = this._windowDockIconActors?.get(actor);
      if (!dockIconActor) return null;

      this._windowDockIconActors.delete(actor);

      let state = this._hiddenDockIconActors?.get(dockIconActor);
      if (!state) return { dockIconActor, opacity: null };

      state.count--;
      if (state.count <= 0) this._hiddenDockIconActors.delete(dockIconActor);

      return { dockIconActor, opacity: state.opacity };
    }

    _restoreDockIconForWindow(actor, animate = true) {
      let dockIconActor = this._windowDockIconActors?.get(actor);
      if (!dockIconActor) return;

      this._windowDockIconActors.delete(actor);
      this._restoreDockIconActor(dockIconActor, animate);
    }

    _animateDockIconOpacity(
      dockIconActor,
      fromOpacity,
      targetOpacity,
      animate,
      fullDistance = 255,
    ) {
      if (!dockIconActor || dockIconActor.is_destroyed?.()) return;

      try {
        dockIconActor.remove_all_transitions?.();

        if (!animate) {
          dockIconActor.opacity = targetOpacity;
          return;
        }

        dockIconActor.opacity = fromOpacity;

        let distance = Math.abs(targetOpacity - fromOpacity);
        if (distance < 1) {
          dockIconActor.opacity = targetOpacity;
          return;
        }

        dockIconActor.ease({
          opacity: targetOpacity,
          duration: Math.max(
            1,
            Math.round(
              other_duration_2 * (distance / Math.max(1, fullDistance)),
            ),
          ),
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
      } catch {}
    }

    _restoreDockIconActor(dockIconActor, animate = true) {
      let state = this._hiddenDockIconActors?.get(dockIconActor);
      if (!state) return;

      state.count--;
      if (state.count > 0) return;

      this._hiddenDockIconActors.delete(dockIconActor);
      let opacity = state.opacity ?? 255;
      dockIconActor._originDockIconTargetOpacity = opacity;
      const oldOpacityVal = dockIconActor.opacity ?? 0;
      this._animateDockIconOpacity(
        dockIconActor,
        oldOpacityVal,
        opacity,
        animate,
        opacity,
      );
    }

    _restoreAllDockIcons() {
      for (let actor of [...(this._windowDockIconActors?.keys?.() ?? [])])
        this._restoreDockIconForWindow(actor, false);

      for (let [dockIconActor, state] of this._hiddenDockIconActors ?? []) {
        try {
          dockIconActor.opacity = state.opacity ?? 255;
        } catch {}
      }

      this._hiddenDockIconActors?.clear();
    }

    _isIdentityWindowTransform(actor) {
      return (
        Math.abs(actor.translation_x ?? 0) < 0.5 &&
        Math.abs(actor.translation_y ?? 0) < 0.5 &&
        Math.abs((actor.scale_x ?? 1) - 1) < 0.01 &&
        Math.abs((actor.scale_y ?? 1) - 1) < 0.01
      );
    }

    _clearWorkspaceUnminimizeWait(actor) {
      let id = this._workspaceUnminimizeIds?.get(actor);
      if (!id) return;

      GLib.Source.remove(id);
      this._workspaceUnminimizeIds.delete(actor);
    }

    _animateStageOffWindowIconPair(actor, iconActor, reverse, state) {
      let currentDuration = reverse
        ? currentProgressedCubicUnminimizeDuration
        : currentProgressedCubicMinimizeDuration;
      let currentCubicSource = reverse
        ? currentProgressedCubicUnminimizeSource
        : currentProgressedCubicMinimizeSource;
      let currentOpacityDelay = reverse
        ? unminimizeOpacityDelayIcon
        : minimizeOpacityDelay;
      let currentOpacityDuration = Math.max(
        1,
        reverse ? unminimizeOpacityIcon : minimizeOpacityIcon,
      );
      let currentProgressedCubic = reverse
        ? currentProgressedCubicUnminimize
        : currentProgressedCubicMinimize;
      let currentOpacityProgressedCubic =
        currentOpacityDelay === 0 && currentOpacityDuration === currentDuration
          ? currentProgressedCubic
          : _getProgressedCubic(currentCubicSource, currentOpacityDuration);
      let startTime = GLib.get_monotonic_time();
      let token = this._nextAnimationToken(actor);
      let actorFromTranslationX = _finiteOr(actor.translation_x, 0);
      let actorFromTranslationY = _finiteOr(actor.translation_y, 0);
      let actorFromScaleX = _finiteOr(actor.scale_x, 1);
      let actorFromScaleY = _finiteOr(actor.scale_y, 1);
      let actorFromOpacity = _finiteOr(actor.opacity, 255);
      let actorTargetTranslationX = reverse ? 0 : state.targetTranslationX;
      let actorTargetTranslationY = reverse ? 0 : state.targetTranslationY;
      let actorTargetScaleX = reverse ? 1 : state.targetScaleX;
      let actorTargetScaleY = reverse ? 1 : state.targetScaleY;
      let actorTargetOpacity = reverse ? 255 : 0;
      let actorOpacityDelta = actorTargetOpacity - actorFromOpacity;
      let iconFromX = iconActor
        ? _finiteOr(iconActor.x ?? iconActor.get_x?.(), 0)
        : 0;
      let iconFromY = iconActor
        ? _finiteOr(iconActor.y ?? iconActor.get_y?.(), 0)
        : 0;
      let iconFromScaleX = iconActor ? _finiteOr(iconActor.scale_x, 1) : 1;
      let iconFromScaleY = iconActor ? _finiteOr(iconActor.scale_y, 1) : 1;
      let iconFromOpacity = iconActor ? _finiteOr(iconActor.opacity, 255) : 0;
      let windowX = state.windowX;
      let windowY = state.windowY;
      let windowWidth = Math.max(1, state.windowWidth);
      let windowHeight = Math.max(1, state.windowHeight);
      let iconBaseWidth = Math.max(1, state.icon.width);
      let iconBaseHeight = Math.max(1, state.icon.height);
      let invWindowWidth = 1 / windowWidth;
      let invWindowHeight = 1 / windowHeight;
      let invIconBaseWidth = 1 / iconBaseWidth;
      let invIconBaseHeight = 1 / iconBaseHeight;
      let iconTargetX = reverse ? windowX : state.icon.x;
      let iconTargetY = reverse ? windowY : state.icon.y;
      let iconTargetScaleX = reverse ? windowWidth * invIconBaseWidth : 1;
      let iconTargetScaleY = reverse ? windowHeight * invIconBaseHeight : 1;
      let iconTargetOpacity = reverse ? 0 : 255;
      let iconOpacityDelta = iconTargetOpacity - iconFromOpacity;
      let trackingActor = reverse ? null : state.icon.sourceActor;
      let trackingGeometry = { x: 0, y: 0, width: 0, height: 0 };
      let trackingX = state.icon.x;
      let trackingY = state.icon.y;
      let trackingWidth = state.icon.width;
      let trackingHeight = state.icon.height;
      let updateTrackingTarget = () => {};
      if (trackingActor) {
        updateTrackingTarget = (smooth) => {
          if (
            !this._readTransformedActorGeometry(trackingActor, trackingGeometry)
          )
            return;

          let nextWidth = Math.min(trackingGeometry.width, windowWidth);
          let nextHeight = Math.min(trackingGeometry.height, windowHeight);
          trackingX += (trackingGeometry.x - trackingX) * smooth;
          trackingY += (trackingGeometry.y - trackingY) * smooth;
          trackingWidth += (nextWidth - trackingWidth) * smooth;
          trackingHeight += (nextHeight - trackingHeight) * smooth;
          actorTargetTranslationX = trackingX - windowX;
          actorTargetTranslationY = trackingY - windowY;
          actorTargetScaleX = trackingWidth * invWindowWidth;
          actorTargetScaleY = trackingHeight * invWindowHeight;
          iconTargetX = trackingX;
          iconTargetY = trackingY;
          iconTargetScaleX = trackingWidth * invIconBaseWidth;
          iconTargetScaleY = trackingHeight * invIconBaseHeight;
        };
      }
      let updateIconFrame = () => {};
      if (iconActor) {
        updateIconFrame = (eased, opacityEased) => {
          if (iconActor.is_destroyed?.()) return;

          iconActor.set_position(
            iconFromX + (iconTargetX - iconFromX) * eased,
            iconFromY + (iconTargetY - iconFromY) * eased,
          );
          iconActor.set_scale(
            iconFromScaleX + (iconTargetScaleX - iconFromScaleX) * eased,
            iconFromScaleY + (iconTargetScaleY - iconFromScaleY) * eased,
          );
          iconActor.opacity = Math.clamp(
            Math.round(iconFromOpacity + iconOpacityDelta * opacityEased),
            0,
            255,
          );
        };
      }
      let finish = () => {
        updateTrackingTarget(1);
        this._windowAnimationIds.delete(actor);

        actor.translation_x = _finiteOr(actorTargetTranslationX, 0);
        actor.translation_y = _finiteOr(actorTargetTranslationY, 0);
        actor.scale_x = _finiteOr(actorTargetScaleX, 1);
        actor.scale_y = _finiteOr(actorTargetScaleY, 1);
        actor.opacity = _finiteOr(actorTargetOpacity, 255);

        if (iconActor && !iconActor.is_destroyed?.()) {
          iconActor.set_position(
            _finiteOr(iconTargetX, 0),
            _finiteOr(iconTargetY, 0),
          );
          iconActor.set_scale(
            _finiteOr(iconTargetScaleX, 1),
            _finiteOr(iconTargetScaleY, 1),
          );
          iconActor.opacity = _finiteOr(iconTargetOpacity, 255);
        }

        if (reverse) {
          this._releaseWindowIconActor(actor, iconActor);
          this._resetWindowActor(actor);
          this._completeUnminimize(actor);
          this._restoreDockIconForWindow(actor, true);
          this._destroyIconAnimationActor(iconActor, false, false);
          return;
        }

        this._completeMinimize(actor);
        this._releaseWindowIconActor(actor, iconActor);
        this._destroyIconAnimationActor(iconActor, true, false);
        actor.opacity = 0;
      };

      this._raiseWindowIconActor(iconActor);

      let frameId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        FRAME_INTERVAL,
        () => {
          if (
            !this._isCurrentAnimation(actor, token) ||
            actor.is_destroyed?.()
          ) {
            this._windowAnimationIds.delete(actor);
            this._destroyIconAnimationActor(iconActor, true, false);
            return GLib.SOURCE_REMOVE;
          }

          let elapsed = (GLib.get_monotonic_time() - startTime) / 1000;
          let eased = _progressFromCubicTable(currentProgressedCubic, elapsed);
          let opacityEased = _progressFromCubicTable(
            currentOpacityProgressedCubic,
            elapsed - currentOpacityDelay,
          );

          updateTrackingTarget(ICON_TRACKING_SMOOTH);

          actor.translation_x =
            actorFromTranslationX +
            (actorTargetTranslationX - actorFromTranslationX) * eased;
          actor.translation_y =
            actorFromTranslationY +
            (actorTargetTranslationY - actorFromTranslationY) * eased;
          actor.scale_x =
            actorFromScaleX + (actorTargetScaleX - actorFromScaleX) * eased;
          actor.scale_y =
            actorFromScaleY + (actorTargetScaleY - actorFromScaleY) * eased;
          actor.opacity = Math.clamp(
            Math.round(actorFromOpacity + actorOpacityDelta * opacityEased),
            0,
            255,
          );

          updateIconFrame(eased, opacityEased);

          if (elapsed < currentDuration) return GLib.SOURCE_CONTINUE;

          finish();
          return GLib.SOURCE_REMOVE;
        },
      );

      this._windowAnimationIds.set(actor, frameId);
    }

    _animateWindowToIcon(actor, reverse) {
      if (!actor) return;

      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      if (reverse && this._isMetaWindowOnOtherWorkspace(metaWindow)) {
        this._finishStageOffUnminimizeWithoutAnimation(actor, true);
        return;
      }

      if (reverse && this._isWorkspaceJumpUnsafe()) {
        this._finishStageOffUnminimizeWithoutAnimation(actor, true);
        return;
      }

      let icon = this._getWindowIcon(actor);
      if (!icon) {
        this._destroyWindowIconActor(actor, true);
        if (reverse) this._finishStageOffUnminimizeWithoutAnimation(actor);
        else this._completeMinimize(actor);
        return;
      }

      this._destroyWindowIconActor(actor, true);
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
      if (
        !Number.isFinite(windowWidth) ||
        !Number.isFinite(windowHeight) ||
        windowWidth <= 0 ||
        windowHeight <= 0
      ) {
        if (reverse) this._finishStageOffUnminimizeWithoutAnimation(actor);
        else this._completeMinimize(actor);
        return;
      }

      let { x: windowX, y: windowY } = this._getActorPosition(actor);
      let targetScaleX = icon.width / windowWidth;
      let targetScaleY = icon.height / windowHeight;
      let targetTranslationX = icon.x - windowX;
      let targetTranslationY = icon.y - windowY;
      let iconActor = this._createWindowIconAnimationActor(actor, icon);
      this._hideDockIconForWindow(actor, icon.sourceActor, !reverse);

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

      if (reverse) {
        iconActor.set_position(icon.x, icon.y);
        iconActor.set_scale(1, 1);
        iconActor.opacity = 255;
      } else {
        iconActor.set_position(windowX, windowY);
        iconActor.set_scale(
          windowWidth / Math.max(1, icon.width),
          windowHeight / Math.max(1, icon.height),
        );
        iconActor.opacity = 0;
      }

      this._animateStageOffWindowIconPair(actor, iconActor, reverse, {
        icon,
        windowX,
        windowY,
        windowWidth,
        windowHeight,
        targetScaleX,
        targetScaleY,
        targetTranslationX,
        targetTranslationY,
      });
    }
  };
