// SPDX-License-Identifier: GPL-2.0-or-later
// OriginUICC – Notification Banner Remake

import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  animateActorOpen,
  restoreActor,
  stopActorAnimation,
} from "./remakeQS.js";

// helpers

function _safeRestoreActor(actor) {
  try {
    restoreActor(actor);
  } catch (_) {}
}

// main class

export class NotificationBannerRemake {
  constructor() {
    this._animationIds = new Map();
    this._animationTokens = new WeakMap();

    this._origUpdateShowing = null;
    this._origHide = null;
  }
  addBackgroundBlur(EL, status = "add") {
    if (!EL || typeof EL.add_effect !== "function") return null;

    const effectName = "originuicc-blur-effect";

    if (status === "remove") {
      EL.remove_effect_by_name?.(effectName);
      EL.set_style?.("");
      return null;
    }

    if (status !== "add")
      throw new Error(`Unknown background blur status: ${status}`);

    // Glass style with rounded corners (border-radius) & crisp clipping
    EL.set_style?.(
      "background-color: rgba(35, 35, 45, 0.55) !important; " +
        "border-radius: 24px !important; " +
        "border: 1px solid rgba(255, 255, 255, 0.18) !important; " +
        "box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3) !important;",
    );

    let blurEffect = EL.get_effect?.(effectName);
    if (!blurEffect) {
      blurEffect = new Shell.BlurEffect({
        name: effectName,
        radius: 60,
        brightness: 0.6,
        mode: Shell.BlurMode.BACKGROUND,
      });
      EL.add_effect(blurEffect);
    } else {
      blurEffect.set({
        radius: 60,
        brightness: 0.6,
        mode: Shell.BlurMode.BACKGROUND,
      });
    }

    blurEffect.queue_repaint();

    return blurEffect;
  }

  // public

  enable() {
    const tray = Main.messageTray;
    if (!tray) return;

    tray._bannerBin?.add_style_class_name("originuicc-notification-bin");

    this._origUpdateShowing = tray._updateShowingNotification.bind(tray);
    tray._updateShowingNotification = () => this._onShowNotification(tray);

    this._origHide = tray._hideNotification.bind(tray);
    tray._hideNotification = (animate) =>
      this._onHideNotification(tray, animate);
  }

  disable() {
    const tray = Main.messageTray;
    if (!tray) return;

    // Restore originals
    if (this._origUpdateShowing) {
      tray._updateShowingNotification = this._origUpdateShowing;
      this._origUpdateShowing = null;
    }
    if (this._origHide) {
      tray._hideNotification = this._origHide;
      this._origHide = null;
    }

    // Stop animations and remove style
    this._stopAllAnimations(true);
    tray._bannerBin?.remove_style_class_name("originuicc-notification-bin");
    tray._banner?.remove_style_class_name("originuicc-notification-banner");
  }

  // private

  _onShowNotification(tray) {
    tray._notificationState = 1;

    tray._notification.acknowledged = true;
    tray._notification.playSound?.();

    const isCritical = tray._notification.urgency === 3;
    const forceExpanded = tray._notification.source?.policy?.forceExpanded;
    if (isCritical || forceExpanded) tray._expandBanner?.(true);

    const bannerBin = tray._bannerBin;
    if (!bannerBin) return;

    if (tray.get_parent?.()) {
      tray.get_parent().set_child_above_sibling(tray, null);
    }
    if (bannerBin.get_parent?.()) {
      bannerBin.get_parent().set_child_above_sibling(bannerBin, null);
    }

    tray._banner?.add_style_class_name("originuicc-notification-banner");
    tray._ensureBannerFocused?.();

    const bannerH = tray._banner?.height || 80;
    const bannerW = tray._bannerBin?.width || 400;
    const startY = -bannerH;

    stopActorAnimation(
      bannerBin,
      this._animationIds,
      this._animationTokens,
      false,
    );

    // const bannerTarget = tray._banner || bannerBin;
    // this.addBackgroundBlur(bannerTarget, "add");
    const de = 200;

    animateActorOpen(
      bannerBin,
      {
        translateY: { value: startY, cubicBezier: [0.3, 1.5, 0.5, 1] },
        translateX: {
          delay: 150,
          value: -bannerW / 2.5,
          cubicBezier: [0.23, 1.3, 0.2, 1],
        },
        scaleX: { delay: 175, value: 0.0025, cubicBezier: [0.23, 1.5, 0.2, 1] },
        scaleY: { delay: 0, value: 0.05, cubicBezier: [0.23, 1.5, 0.2, 1] },
        opacity: 0,
      },
      {
        translateY: { value: 115, delay: -100 },
        translateX: 0,
        scaleX: { value: 1, delay: 0 },
        scaleY: { value: 1, delay: 0 },
        opacity: { value: 255, delay: -de },
      },
      {
        duration: 850 + de,
        delay: 0,
        animationIds: this._animationIds,
        animationTokens: this._animationTokens,
        tokenSymbol: Symbol("notification-open"),
        errorTag: "OriginUICC notification open animation failed",
        onFinish: () => {
          tray._notificationState = 2;
          tray._showNotificationCompleted?.();
          tray._updateState?.();
        },
      },
    );
  }

  _onHideNotification(tray, animate) {
    const bannerBin = tray._bannerBin;

    tray._notificationFocusGrabber?.ungrabFocus();
    tray._banner?.disconnectObject(tray);
    tray._resetNotificationLeftTimeout?.();

    stopActorAnimation(
      bannerBin,
      this._animationIds,
      this._animationTokens,
      false,
    );

    const finishHide = () => {
      tray._notificationState = 0;
      tray._hideNotificationCompleted?.();
      tray._updateState?.();
    };

    if (!bannerBin || !tray._banner) {
      finishHide();
      return;
    }

    tray._notificationState = 3;

    animateActorOpen(
      bannerBin,
      {
        scaleX: 1,
        scaleY: 1,
        opacity: 255,
      },
      {
        scaleX: 0.5,
        scaleY: 0.5,
        opacity: 0,
      },
      {
        duration: 200,
        delay: 0,
        cubicBezier: [0.25, 0.1, 0.25, 1],
        animationIds: this._animationIds,
        animationTokens: this._animationTokens,
        tokenSymbol: Symbol("notification-close"),
        errorTag: "OriginUICC notification close animation failed",
        onFinish: finishHide,
      },
    );
  }

  _stopAllAnimations(restore = false) {
    for (const [actor, frameId] of this._animationIds) {
      GLib.source_remove(frameId);
      if (restore) _safeRestoreActor(actor);
    }
    this._animationIds.clear();
    this._animationTokens = new WeakMap();
  }
}
