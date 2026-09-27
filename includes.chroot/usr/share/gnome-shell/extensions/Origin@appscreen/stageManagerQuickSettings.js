"use strict";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import {
  CENTRE_STAGE_ICON_SCALE,
  DEFAULT_STAGE_ICON_NAME,
} from "./config.js";

function _getExtensionDir() {
  let [path] = GLib.filename_from_uri(import.meta.url);
  return GLib.path_get_dirname(path);
}

function _getCentreStageIcon() {
  try {
    return Gio.FileIcon.new(
      Gio.File.new_for_path(
        GLib.build_filenamev([_getExtensionDir(), "icon", "centreStage.svg"]),
      ),
    );
  } catch {
    return null;
  }
}

export const StageModeToggle = GObject.registerClass(
  class StageModeToggle extends QuickSettings.QuickToggle {
    constructor(owner) {
      let stageIcon = _getCentreStageIcon();
      super({
        title: "Centre stage",
        subtitle: "Off",
        ...(stageIcon
          ? { gicon: stageIcon }
          : { iconName: DEFAULT_STAGE_ICON_NAME }),
        toggleMode: true,
      });

      this._owner = owner;
      this._icon?.set_pivot_point?.(0.5, 0.5);
      this._icon?.set_scale?.(CENTRE_STAGE_ICON_SCALE, CENTRE_STAGE_ICON_SCALE);
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

export const StageModeIndicator = GObject.registerClass(
  class StageModeIndicator extends QuickSettings.SystemIndicator {
    constructor(owner) {
      super();

      this._indicator = this._addIndicator();
      let stageIcon = _getCentreStageIcon();
      if (stageIcon) this._indicator.gicon = stageIcon;
      else this._indicator.icon_name = DEFAULT_STAGE_ICON_NAME;
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
