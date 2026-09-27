"use strict";
import GLib from "gi://GLib";

/** Completion, cancellation, and cleanup paths for unminimize animation. */
export const RemakeUnminimizeAnimMixin = (Base) =>
  class extends Base {
    _clearWorkspaceUnminimizeWaits() {
      for (let id of this._workspaceUnminimizeIds?.values?.() ?? [])
        GLib.Source.remove(id);

      this._workspaceUnminimizeIds?.clear();
    }

    _completeStageOffUnminimizeNow(actor, metaWindow = null, activate = false) {
      this._clearWorkspaceUnminimizeWait(actor);
      this._resetWindowActor(actor);
      actor?.show?.();
      if (actor) actor.opacity = 255;
      this._completeUnminimize(actor);
      if (activate && metaWindow && !metaWindow.minimized)
        this._activateStageMetaWindow(metaWindow);
    }

    _completeStageOffUnminimizeAfterWorkspace(actor, metaWindow, workspace) {
      this._clearWorkspaceUnminimizeWait(actor);

      let startTime = GLib.get_monotonic_time();
      let id = 0;
      id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        if (!actor || actor.is_destroyed?.()) {
          this._workspaceUnminimizeIds.delete(actor);
          return GLib.SOURCE_REMOVE;
        }

        let activeWorkspace = global.workspace_manager.get_active_workspace();
        let timedOut = (GLib.get_monotonic_time() - startTime) / 1000 > 700;
        if (activeWorkspace !== workspace && !timedOut)
          return GLib.SOURCE_CONTINUE;

        this._workspaceUnminimizeIds.delete(actor);
        this._completeStageOffUnminimizeNow(actor, metaWindow, true);
        return GLib.SOURCE_REMOVE;
      });

      this._workspaceUnminimizeIds.set(actor, id);
    }

    _finishStageOffUnminimizeWithoutAnimation(
      actor,
      activateWorkspace = false,
    ) {
      if (!actor) return;

      let metaWindow = actor.meta_window ?? actor.get_meta_window?.();
      let workspace = this._getMetaWindowWorkspace(metaWindow);
      if (
        activateWorkspace &&
        workspace &&
        workspace !== global.workspace_manager.get_active_workspace() &&
        this._activateStageWindowWorkspace(metaWindow)
      ) {
        this._completeStageOffUnminimizeAfterWorkspace(
          actor,
          metaWindow,
          workspace,
        );
        return;
      }

      this._completeStageOffUnminimizeNow(actor, metaWindow, activateWorkspace);
    }

    _stopWindowAnimation(actor) {
      this._clearDelayedAnimation(actor);
      let frameId = this._windowAnimationIds?.get(actor);
      if (frameId) {
        GLib.Source.remove(frameId);
        this._windowAnimationIds.delete(actor);
      }
      this._nextAnimationToken(actor);
      actor?.remove_all_transitions?.();
    }

    _clearDelayedAnimation(actor) {
      let delayId = this._delayedAnimationIds?.get(actor);
      if (!delayId) return;

      GLib.Source.remove(delayId);
      this._delayedAnimationIds.delete(actor);
    }

    _stopAllWindowAnimations() {
      for (let frameId of this._windowAnimationIds?.values?.() ?? [])
        GLib.Source.remove(frameId);
      for (let delayId of this._delayedAnimationIds?.values?.() ?? [])
        GLib.Source.remove(delayId);

      this._windowAnimationIds?.clear();
      this._delayedAnimationIds?.clear();
      this._actorAnimationTokens?.clear();
      this._destroyAllWindowIconActors();
      this._dockIconSourceActors?.clear();
    }

    _resetWindowActor(actor) {
      if (!actor) return;

      this._clearWorkspaceUnminimizeWait(actor);
      let entry =
        this._stageEntries?.get(actor) ??
        this._restoringStageEntries?.get(actor);
      if (entry) this._destroyStageSurfaces(entry);
      this._restoringStageEntries?.delete(actor);

      let hasReleasedIcon = this._hasReleasedWindowIconActor(actor);
      this._destroyWindowIconActor(actor);
      if (!hasReleasedIcon) this._restoreDockIconForWindow(actor, false);
      this._disconnectStageActorSignals(actor);
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

      this._windowActors?.delete(actor);
    }

    _resetWindowActors() {
      this._clearStageHover();

      for (let actor of this._windowActors ?? []) {
        this._resetWindowActor(actor);
      }

      for (let entry of this._restoringStageEntries?.values?.() ?? [])
        this._destroyStageSurfaces(entry);

      this._stopAllWindowAnimations();
      this._destroyStageHitActors();
      this._windowActors?.clear();
      this._stageEntries?.clear();
      this._restoringStageEntries?.clear();
      this._purgeOrphanStageSurfaces();
      this._stageSurfaceActors?.clear();
      this._stageHitActors?.clear();
      this._stageOrder = [];
      this._pendingStageWindows?.clear();
      this._pendingRestoreTargets?.clear();
      this._pendingStageInsertIndexes?.clear();
      this._restoringWindows?.clear();
      this._dockIconSourceActors?.clear();
      this._disconnectAllStageUnmanagedSignals();
      this._destroyAllWindowIconActors();
    }

    _destroyWindowActor(actor) {
      if (!actor) return;

      this._clearWorkspaceUnminimizeWait(actor);
      let entry =
        this._stageEntries?.get(actor) ??
        this._restoringStageEntries?.get(actor);
      if (entry) this._destroyStageSurfaces(entry);
      this._restoringStageEntries?.delete(actor);

      let hasReleasedIcon = this._hasReleasedWindowIconActor(actor);
      this._destroyWindowIconActor(actor);
      if (!hasReleasedIcon) this._restoreDockIconForWindow(actor, false);
      this._disconnectStageActorSignals(actor);
      this._stopWindowAnimation(actor);

      actor.remove_all_transitions?.();

      this._windowActors?.delete(actor);

      this._windowAnimationIds?.delete(actor);
      this._restoringStageEntries?.delete(actor);

      actor._stageDestroySignal = 0;
    }
  };
