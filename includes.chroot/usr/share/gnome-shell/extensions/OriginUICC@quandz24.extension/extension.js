import Gio from "gi://Gio";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { QuickSettingsRemake } from "./remakeQS.js";
import { OverviewRemake } from "./remakeOverview.js";
import { DialogsRemake } from "./remakeDialogs.js";

const EXTRA_STYLESHEETS = [
  "stylesheetQS.css",
  "stylesheetOverview.css",
  "stylesheetDialogs.css",
];

export default class OriginUICC extends Extension {
  enable() {
    this._styleFiles = [];
    this._modules = [
      new QuickSettingsRemake(this),
      new OverviewRemake(),
      new DialogsRemake(),
    ];

    this._loadStylesheets();

    for (const module of this._modules) module.enable();
  }

  disable() {
    for (const module of this._modules.reverse()) module.disable();

    this._modules = [];
    this._unloadStylesheets();
  }

  _loadStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();

    for (const name of EXTRA_STYLESHEETS) {
      const file = this._getStylesheetFile(name);

      try {
        theme.load_stylesheet(file);
        this._styleFiles.push(file);
      } catch {}
    }
  }

  _getStylesheetFile(name) {
    if (this.dir) return this.dir.get_child(name);

    return Gio.File.new_for_path(`${this.path}/${name}`);
  }

  _unloadStylesheets() {
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();

    for (const file of this._styleFiles.reverse()) {
      try {
        theme.unload_stylesheet(file);
      } catch {}
    }

    this._styleFiles = [];
  }
}
