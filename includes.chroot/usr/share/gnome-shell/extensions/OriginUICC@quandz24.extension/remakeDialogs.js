import GLib from "gi://GLib";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const DIALOG_BLUR_EFFECT_NAME = "originuicc-dialog-backdrop-blur";
const DIALOG_BLUR_RADIUS = 26;
const DIALOG_BLUR_BRIGHTNESS = 1;
const DIALOG_BLUR_CORNER_RADIUS = 44;

export class DialogsRemake {
  enable() {
    this._dialogBlurSetupId = 0;
    this._colorSettings = St.Settings.get();
    this._colorSchemeSignalId = this._colorSettings.connect(
      "notify::color-scheme",
      () => this._syncColorScheme(),
    );

    this._syncColorScheme();
    this._setupDialogBackdropBlur();
  }

  disable() {
    if (this._dialogBlurSetupId) {
      GLib.source_remove(this._dialogBlurSetupId);
      this._dialogBlurSetupId = 0;
    }

    if (this._colorSchemeSignalId && this._colorSettings) {
      this._colorSettings.disconnect(this._colorSchemeSignalId);
      this._colorSchemeSignalId = 0;
    }

    this._clearColorScheme();
    this._colorSettings = null;
  }

  _syncColorScheme() {
    const actor = Main.layoutManager?.modalDialogGroup;

    if (!actor) return;

    actor.remove_style_class_name("originuicc-light");
    actor.remove_style_class_name("originuicc-dark");
    actor.add_style_class_name(this._getColorSchemeClass());
  }

  _clearColorScheme() {
    const actor = Main.layoutManager?.modalDialogGroup;

    if (!actor) return;

    actor.remove_style_class_name("originuicc-light");
    actor.remove_style_class_name("originuicc-dark");
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

  _setupDialogBackdropBlur() {
    this._syncDialogBackdropBlur();

    this._dialogBlurSetupId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      () => {
        this._syncDialogBackdropBlur();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _syncDialogBackdropBlur() {
    const group = Main.layoutManager?.modalDialogGroup;
    if (!group) return;

    this._walkActors(group, (actor) => {
      if (!this._hasStyleClass(actor, "modal-dialog")) return;

      this._blurTracker?.add(actor, {
        radius: DIALOG_BLUR_RADIUS,
        brightness: DIALOG_BLUR_BRIGHTNESS,
        cornerRadius: DIALOG_BLUR_CORNER_RADIUS,
      });
    });
  }

  _walkActors(actor, callback) {
    if (!actor || actor.is_destroyed?.()) return;

    callback(actor);

    for (const child of actor.get_children?.() ?? [])
      this._walkActors(child, callback);
  }

  _hasStyleClass(actor, styleClass) {
    try {
      return actor?.has_style_class_name?.(styleClass) ?? false;
    } catch (_) {
      return false;
    }
  }
}
