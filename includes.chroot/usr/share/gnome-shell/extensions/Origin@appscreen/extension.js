"use strict";
import { _prewarmProgressedCubics, _updateCurrentProgressedCubics } from "./animationEngine.js";
import { AnimationEngineMixin } from "./animationEngine.js";
import { RemakeMinimizeAnimMixin } from "./remakeMinimizeAnim.js";
import { RemakeUnminimizeAnimMixin } from "./remakeUnminimizeAnim.js";
import { StageManagerStageScrollMixin } from "./stageManagerStageScroll.js";
import { StageManagerMixin } from "./stageManager.js";

// Mixins keep behaviour on one extension instance while making each subsystem
// independently navigable. Order is deliberate: later mixins depend on earlier APIs.
const OriginAppGridBase = StageManagerMixin(
  StageManagerStageScrollMixin(
    RemakeUnminimizeAnimMixin(
      RemakeMinimizeAnimMixin(AnimationEngineMixin(class {})),
    ),
  ),
);

export default class OriginAppGrid extends OriginAppGridBase {
  enable() {
    _prewarmProgressedCubics();
    this._opened = false;
    this._timeoutIds = new Set();
    this._windowAnimationIds = new Map();
    this._delayedAnimationIds = new Map();
    this._windowActors = new Set();
    this._stageMode = false;
    _updateCurrentProgressedCubics(this._stageMode);
    this._stageEntries = new Map();
    this._restoringStageEntries = new Map();
    this._stageOrder = [];
    this._stageSurfaceActors = new Set();
    this._stageHitActors = new Map();
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
    this._stageFocusSignal = 0;
    this._stageSizeChangeSignal = 0;
    this._stageSizeChangedSignal = 0;
    this._stageFocusedWindow = null;
    this._stageFocusedWindowSignals = [];
    this._stageWindowDestroySignal = 0;
    this._stageWindowCleanupId = 0;
    this._stageAutoHideId = 0;
    this._stageShowDelayId = 0;
    this._stageEdgeRevealId = 0;
    this._stageVisibilityTransitionId = 0;
    this._stageVisibilityTransitioning = false;
    this._stagePointerPollId = 0;
    this._stageRevealPointerSinceUs = 0;
    this._stageLastPollAutoHideUs = 0;
    this._overviewHiddenSignal = 0;
    this._workspaceSwitchSignal = 0;
    this._workspaceActiveSignal = 0;
    this._lastWorkspaceSwitchUs = 0;
    this._activeWorkspace = global.workspace_manager.get_active_workspace();
    this._stageHidden = false;
    this._stageOffsetX = 0;
    this._stagePointer = null;
    this._stageClickRetryId = 0;
    this._stageInputCaptureSignal = 0;
    this._stageCaptureSignal = 0;
    this._stageGrab = null;
    this._stageGrabIsModal = false;
    this._stageHoverEntry = null;
    this._queuedStageMode = null;
    this._stageScrollOffset = 0;
    this._stageMaxScroll = 0;
    this._windowPushIds = new Map();
    this._windowIconActors = new Map();
    this._windowIconSurfaces = new Set();
    this._windowDockIconActors = new Map();
    this._hiddenDockIconActors = new Map();
    this._dockIconSourceActors = new Map();
    this._workspaceUnminimizeIds = new Map();
    this._stageUnmanagedSignals = new Map();
    this.heightStageCenter = 0;

    this._createStageToggle();
    this._ensureCoverLayer();
    this._ensureStageEdgeRevealLayer();
    this._connectStageInputCapture();
    this._connectMonitorChanged();
    this._purgeOrphanStageSurfaces();
    this._connectWindowAnimations();
    this._connectStageStackSignals();
    this._connectStageCleanupSignals();
    this._connectWorkspaceSwitchSignals();
  }
  disable() {
    this._setStageMode(false);
    if (this._signal) {
      this._fitMode.disconnect(this._signal);
      this._signal = 0;
    }
    this._disconnectWindowAnimations();
    this._destroyCoverLayer();
    this._destroyStageToggle();
    this._stopAllWindowAnimations();
    this._clearWorkspaceUnminimizeWaits();
    this._resetWindowActors();
    this._clearStageIdles();
    this._clearStageModeSwitch();
    this._clearStageClickRetry();
    this._disconnectMonitorChanged();
    this._disconnectStageStackSignals();
    this._disconnectStageCleanupSignals();
    this._disconnectWorkspaceSwitchSignals();
    this._clearStageWindowCleanup();
    this._clearStageAutoHideCheck();
    this._clearStageShowDelay();
    this._clearStageVisibilityTransition();
    this._destroyStageEdgeRevealLayer();
    this._stopStagePointerPoll();
    this._disconnectStageInputCapture();
    this._clearStagePointer();
    this._clearWindowPushAnimations();
  }

}
