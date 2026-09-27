import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Background from "resource:///org/gnome/shell/ui/background.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  animateActorOpen,
  stopActorAnimation,
  restoreActor,
  _cubicBezierProgress,
  animationDuration,
  animationCubicBezier,
  startScale,
  startTranslateY,
  FRAME_INTERVAL,
} from "./remakeQS.js";

export class DateMenuRemake {
  constructor(extension = null) {
    this._extension = extension;
    this._dateMenus = new Map();
    this._setupId = 0;
    this._colorSchemeSignalId = 0;
    this._colorSettings = null;
    this._animationIds = new Map();
    this._animationTokens = new WeakMap();
  }

  enable() {
    this._dateMenus = new Map();
    this._setupId = 0;
    this._colorSchemeSignalId = 0;
    this._animationIds = new Map();
    this._animationTokens = new WeakMap();
    this._colorSettings = St.Settings.get();

    this._colorSchemeSignalId = this._colorSettings.connect(
      "notify::color-scheme",
      () => this._syncAllColorSchemes(),
    );

    this._setupDateMenuHook();

    this._setupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      this._setupDateMenuHook();
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    if (this._setupId) {
      GLib.source_remove(this._setupId);
      this._setupId = 0;
    }

    if (this._colorSchemeSignalId && this._colorSettings) {
      this._colorSettings.disconnect(this._colorSchemeSignalId);
      this._colorSchemeSignalId = 0;
    }

    this._cleanupAllDateMenus();
    this._stopAllAnimations(true);
    this._colorSettings = null;
  }

  _getDateMenuButtons() {
    const buttons = new Set();
    const addPanel = (panel) => {
      const button = panel?.statusArea?.dateMenu;
      if (button) buttons.add(button);
    };

    addPanel(Main.panel);

    for (const panelData of global.dashToPanel?.panels ?? []) {
      addPanel(panelData?.panel ?? panelData);
    }

    return buttons;
  }

  _setupDateMenuHook() {
    const buttons = this._getDateMenuButtons();
    const activeMenus = new Set();

    for (const button of buttons) {
      const menu = button?.menu;
      if (!menu || !menu.box) continue;
      activeMenus.add(menu);

      if (this._dateMenus.has(menu)) continue;

      const data = {
        signalId: 0,
        button,
        messageList: null,
        calendarColumn: null,
      };

      const [messageList, calendarColumn] = this._getSections(menu, data);

      data.signalId = menu.connect("open-state-changed", (_menu, isOpen) => {
        if (isOpen) {
          const [msgList, calCol] = this._getSections(_menu, data);
          this._syncColorScheme(_menu, msgList, calCol);
          this._animateDateMenuOpen(_menu);
        } else {
          this._stopAllAnimations(true);
        }
      });

      this._dateMenus.set(menu, data);

      this._applyDateMenuStyle(menu, messageList, calendarColumn);
    }

    // Cleanup menus that are no longer active
    for (const [menu, data] of this._dateMenus) {
      if (activeMenus.has(menu)) continue;

      this._revertDateMenuStyle(menu, data);
      this._dateMenus.delete(menu);
    }
  }

  _findActorByClass(rootActor, className) {
    if (!rootActor) return null;
    if (rootActor.has_style_class_name?.(className)) return rootActor;

    const children = rootActor.get_children?.() ?? [];
    for (const child of children) {
      const found = this._findActorByClass(child, className);
      if (found) return found;
    }
    return null;
  }

  _getSections(menu, data = null) {
    let messageList = data?.messageList;
    if (!messageList || messageList.is_destroyed?.()) {
      messageList =
        this._findActorByClass(
          menu?.box,
          "originuicc-datemenu-notifications-section",
        ) ??
        data?.button?._messageList ??
        this._findActorByClass(menu?.box, "message-list");
      if (data && messageList) data.messageList = messageList;
    }

    let calendarColumn = data?.calendarColumn;
    if (!calendarColumn || calendarColumn.is_destroyed?.()) {
      calendarColumn =
        this._findActorByClass(
          menu?.box,
          "originuicc-datemenu-calendar-section",
        ) ??
        data?.button?._calendar?.get_parent?.() ??
        this._findActorByClass(menu?.box, "datemenu-calendar-column");
      if (data && calendarColumn) data.calendarColumn = calendarColumn;
    }

    if (messageList) {
      messageList.add_style_class_name(
        "originuicc-datemenu-notifications-section",
      );
    }
    if (calendarColumn) {
      calendarColumn.add_style_class_name(
        "originuicc-datemenu-calendar-section",
      );
    }

    return [messageList, calendarColumn];
  }

  _animateDateMenuOpen(menu) {
    const data = this._dateMenus.get(menu);
    const [messageList, calendarColumn] = this._getSections(menu, data);

    const sections = [messageList, calendarColumn].filter(
      (actor) => actor && !actor.is_destroyed?.() && actor.visible !== false,
    );

    sections.forEach((actor, index) => {
      const h = actor.get_allocation_box?.().get_height?.() ?? actor.height;
      this._animateItemOpen(actor, index * 80, -h / 2);
    });
  }

  _animateItemOpen(actor, delay, trsY) {
    animateActorOpen(
      actor,
      { translateY: trsY, scaleX: 0.3, scaleY: 0.3, rotateX: 50, opacity: 0 },
      { translateY: 0, scaleX: 1, scaleY: 1, rotateX: 0, opacity: 255 },
      {
        duration: 700,
        cubicBezier: [0.23, 1.2, 0.2, 1],
        delay,
        animationIds: this._animationIds,
        animationTokens: this._animationTokens,
        tokenSymbol: Symbol("datemenu-open-animation"),
        errorTag: "OriginUICC date menu animation failed",
        fill: "both",
      },
    );
  }

  _stopAnimation(actor, restore = false) {
    stopActorAnimation(
      actor,
      this._animationIds,
      this._animationTokens,
      restore,
    );
  }

  _stopAllAnimations(restore = false) {
    for (const [actor, frameId] of this._animationIds) {
      GLib.source_remove(frameId);
      if (restore) restoreActor(actor);
    }

    this._animationIds.clear();
    this._animationTokens = new WeakMap();
  }

  _restoreActor(actor) {
    restoreActor(actor);
  }

  _applyDateMenuStyle(menu, messageList, calendarColumn) {
    // 1. Make BoxPointer transparent
    menu?._boxPointer?.add_style_class_name(
      "originuicc-transparent-boxpointer",
    );

    // 2. Custom class for the datemenu popover
    menu?.box?.add_style_class_name("originuicc-datemenu");

    // 3. Add distinctive classes for the 2 sections (notifications & calendar)
    messageList?.add_style_class_name(
      "originuicc-datemenu-notifications-section",
    );
    calendarColumn?.add_style_class_name(
      "originuicc-datemenu-calendar-section",
    );

    this._syncColorScheme(menu, messageList, calendarColumn);
  }

  _revertDateMenuStyle(menu, data) {
    try {
      if (data?.signalId) menu.disconnect(data.signalId);
    } catch (_) {}

    if (data?.messageList) {
      this._stopAnimation(data.messageList, true);
    }
    if (data?.calendarColumn) {
      this._stopAnimation(data.calendarColumn, true);
    }

    menu?._boxPointer?.remove_style_class_name(
      "originuicc-transparent-boxpointer",
    );
    menu?.box?.remove_style_class_name("originuicc-datemenu");
    menu?.box?.remove_style_class_name("originuicc-dark");
    menu?.box?.remove_style_class_name("originuicc-light");

    data?.messageList?.remove_style_class_name(
      "originuicc-datemenu-notifications-section",
    );
    data?.messageList?.remove_style_class_name("originuicc-dark");
    data?.messageList?.remove_style_class_name("originuicc-light");

    data?.calendarColumn?.remove_style_class_name(
      "originuicc-datemenu-calendar-section",
    );
    data?.calendarColumn?.remove_style_class_name("originuicc-dark");
    data?.calendarColumn?.remove_style_class_name("originuicc-light");
  }

  _cleanupAllDateMenus() {
    for (const [menu, data] of this._dateMenus) {
      this._revertDateMenuStyle(menu, data);
    }
    this._dateMenus.clear();
  }

  _syncAllColorSchemes() {
    for (const [menu, data] of this._dateMenus) {
      const [messageList, calendarColumn] = this._getSections(menu, data);
      this._syncColorScheme(menu, messageList, calendarColumn);
    }
  }

  _syncColorScheme(menu, messageList, calendarColumn) {
    const schemeClass = this._getColorSchemeClass();
    const actors = [menu?.box, messageList, calendarColumn];

    menu?._boxPointer?.add_style_class_name(
      "originuicc-transparent-boxpointer",
    );

    for (const actor of actors) {
      if (!actor) continue;

      actor.remove_style_class_name("originuicc-light");
      actor.remove_style_class_name("originuicc-dark");
      actor.add_style_class_name(schemeClass);
    }
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
}
