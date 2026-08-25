"use strict";

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";

const TOGGLE_DURATION = 400;
const ICON_ANIMATION_DELAY = 450;
const ICON_ANIMATION_IN_DURATION = 600;
const ICON_ANIMATION_OUT_DURATION = 700;
const ICON_ANIMATION_TOTAL_DURATION =
  ICON_ANIMATION_DELAY +
  ICON_ANIMATION_IN_DURATION +
  ICON_ANIMATION_OUT_DURATION;
const ICON_START_SCALE = 0;
const ICON_HOLD_SCALE = 0.2;
const ICON_END_SCALE = 1.5;
const PRIVATE_MODE_SYMBOLIC_ICON = "privateMode-symbolic.svg";
const PRIVATE_MODE_FALLBACK_ICON = "privateModeDark.svg";
const BACKGROUND_SHADER = "privateModeLiquidGlass.glsl";
const BACKGROUND_SHADER_PEAK_SCALE = 1.15;
const BACKGROUND_SHADER_RETURN_DURATION = 1300;
const BACKGROUND_SHADER_WAVE_WIDTH = 0.42;
const BACKGROUND_SHADER_GROW_DURATION =
  ICON_ANIMATION_DELAY + ICON_ANIMATION_IN_DURATION / 2;
const BACKGROUND_SHADER_RETURN_START =
  ICON_ANIMATION_DELAY + ICON_ANIMATION_IN_DURATION;
const BACKGROUND_SHADER_END =
  BACKGROUND_SHADER_RETURN_START + BACKGROUND_SHADER_RETURN_DURATION;
const OVERLAY_DESTROY_DELAY = 80;
const WALLPAPER_START_SCALE = 1;
const WALLPAPER_PEAK_SCALE = 1.05;
const OVERLAY_DURATION = Math.max(
  ICON_ANIMATION_TOTAL_DURATION,
  BACKGROUND_SHADER_END,
);
const WALLPAPER_ANIMATION_DELAY = 390;
const WALLPAPER_ANIMATION_TOTAL_DURATION = Math.max(
  ICON_ANIMATION_TOTAL_DURATION - WALLPAPER_ANIMATION_DELAY,
  1,
);
const WALLPAPER_ANIMATION_IN_DURATION = WALLPAPER_ANIMATION_TOTAL_DURATION / 2;
const WALLPAPER_ANIMATION_OUT_DURATION =
  WALLPAPER_ANIMATION_TOTAL_DURATION - WALLPAPER_ANIMATION_IN_DURATION;
const FRAME_INTERVAL_MS = 16;
const CSS_CUBIC = [0.25, 0.1, 0.25, 1];
const PKEXEC_CANCEL_STATUS = 126;
const MODPROBE_PATHS = [
  "/usr/sbin/modprobe",
  "/sbin/modprobe",
  "/usr/bin/modprobe",
];

const ANIMATABLE_PROPERTIES = [
  "opacity",
  "scale",
  "scaleX",
  "scaleY",
  "x",
  "y",
  "translationX",
  "translationY",
  "width",
  "height",
  "rotationZ",
];

let _animationRecords = new Map();

function _clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

function _cubic(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t;
}

function _cubicDerivative(a, b, t) {
  const inv = 1 - t;
  return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b);
}

function _cubicBezierProgress(cubic, progress) {
  const [x1, y1, x2, y2] = cubic;
  const x = _clamp01(progress);
  let t = x;

  for (let i = 0; i < 8; i++) {
    const slope = _cubicDerivative(x1, x2, t);
    if (Math.abs(slope) < 0.000001) break;

    const next = t - (_cubic(x1, x2, t) - x) / slope;
    if (next < 0 || next > 1) break;

    t = next;
  }

  let lower = 0;
  let upper = 1;
  for (let i = 0; i < 10 && Math.abs(_cubic(x1, x2, t) - x) > 0.000001; i++) {
    if (_cubic(x1, x2, t) < x) lower = t;
    else upper = t;
    t = (lower + upper) / 2;
  }

  return _clamp01(_cubic(y1, y2, t));
}

function _easeProgress(easing, progress) {
  if (Array.isArray(easing) && easing.length === 4)
    return _cubicBezierProgress(easing, progress);

  if (easing === "ease-out")
    return _cubicBezierProgress([0, 0, 0.58, 1], progress);

  return progress;
}

function _iconPath(extension, fileName) {
  return GLib.build_filenamev([extension.path, "icons", fileName]);
}

function _shaderPath(extension, fileName) {
  return GLib.build_filenamev([extension.path, "shaders", fileName]);
}

function _fileIcon(path) {
  return Gio.FileIcon.new(Gio.File.new_for_path(path));
}

function _loadTextFile(path) {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder("utf-8").decode(bytes) : "";
  } catch (_error) {
    return "";
  }
}

function _getPrivateModeIcon(extension, _settings = null) {
  const symbolicPath = _iconPath(extension, PRIVATE_MODE_SYMBOLIC_ICON);
  if (GLib.file_test(symbolicPath, GLib.FileTest.EXISTS))
    return _fileIcon(symbolicPath);

  return _fileIcon(_iconPath(extension, PRIVATE_MODE_FALLBACK_ICON));
}

function _getGradientIcon(extension) {
  return _fileIcon(_iconPath(extension, "privateModeGradient.svg"));
}

function _createBackgroundShaderEffect(extension, width, height) {
  const source = _loadTextFile(_shaderPath(extension, BACKGROUND_SHADER));
  if (!source) return null;

  try {
    const effect = new Clutter.ShaderEffect();
    effect.set_shader_source(source);
    _setShaderFloat(effect, "resolution_x", width);
    _setShaderFloat(effect, "resolution_y", height);
    _setShaderFloat(effect, "amount", 0.0);
    _setShaderFloat(effect, "release", 0.0);
    _setShaderFloat(effect, "peak_scale", BACKGROUND_SHADER_PEAK_SCALE);
    _setShaderFloat(effect, "wave_width", BACKGROUND_SHADER_WAVE_WIDTH);
    _setShaderFloat(effect, "time", 0.0);
    effect.set_enabled(false);
    return effect;
  } catch (error) {
    Main.notify("Private Mode", `Background shader failed: ${error.message}`);
    return null;
  }
}

function _setShaderFloat(effect, name, value) {
  const gvalue = new GObject.Value();
  gvalue.init(GObject.TYPE_FLOAT);
  gvalue.set_float(value);
  effect.set_uniform_value(name, gvalue);
}

function _addBackdropClone(
  container,
  source,
  x,
  y,
  width = null,
  height = null,
) {
  if (!source) return null;

  try {
    const clone = new Clutter.Clone({ source, reactive: false });
    clone.set_position(x, y);
    clone.set_pivot_point?.(0, 0);
    if (width !== null && height !== null) clone.set_size(width, height);
    container.add_child(clone);
    return clone;
  } catch (_error) {
    return null;
  }
}

function _createBackgroundShaderActor(monitor) {
  const actor = new Clutter.Actor({
    reactive: false,
    layout_manager: new Clutter.FixedLayout(),
  });
  actor.set_position(0, 0);
  actor.set_size(monitor.width, monitor.height);
  actor.set_clip(0, 0, monitor.width, monitor.height);
  actor.opacity = 0;

  const stageWidth = global.stage?.width ?? monitor.width;
  const stageHeight = global.stage?.height ?? monitor.height;
  _addBackdropClone(
    actor,
    Main.layoutManager._backgroundGroup,
    -monitor.x,
    -monitor.y,
    stageWidth,
    stageHeight,
  );

  const windowActors = global.get_window_actors?.() ?? [];
  for (const windowActor of windowActors) {
    const metaWindow = windowActor.get_meta_window?.();
    if (!metaWindow || metaWindow.minimized || !windowActor.visible) continue;

    _addBackdropClone(
      actor,
      windowActor,
      (windowActor.x ?? 0) - monitor.x,
      (windowActor.y ?? 0) - monitor.y,
    );
  }

  return actor;
}

function _getActorValue(actor, property) {
  switch (property) {
    case "scale":
      return actor.scaleX ?? actor.scale_x ?? 1;
    case "scaleX":
      return actor.scaleX ?? actor.scale_x ?? 1;
    case "scaleY":
      return actor.scaleY ?? actor.scale_y ?? 1;
    case "translationX":
      return actor.translationX ?? actor.translation_x ?? 0;
    case "translationY":
      return actor.translationY ?? actor.translation_y ?? 0;
    case "rotationZ":
      return actor.rotationAngleZ ?? actor.rotation_angle_z ?? 0;
    default:
      return actor[property] ?? 0;
  }
}

function _setActorValue(actor, property, value) {
  switch (property) {
    case "opacity":
      actor.opacity = Math.round(value);
      break;
    case "scale":
      actor.set_scale(value, value);
      break;
    case "scaleX":
      actor.set_scale(value, _getActorValue(actor, "scaleY"));
      break;
    case "scaleY":
      actor.set_scale(_getActorValue(actor, "scaleX"), value);
      break;
    case "x":
      actor.set_position(value, _getActorValue(actor, "y"));
      break;
    case "y":
      actor.set_position(_getActorValue(actor, "x"), value);
      break;
    case "translationX":
      actor.set({ translationX: value });
      break;
    case "translationY":
      actor.set({ translationY: value });
      break;
    case "width":
      actor.set_size(value, _getActorValue(actor, "height"));
      break;
    case "height":
      actor.set_size(_getActorValue(actor, "width"), value);
      break;
    case "rotationZ":
      actor.set({ rotationAngleZ: value });
      break;
  }
}

function _applyAnimationValues(actor, values) {
  for (const property of ANIMATABLE_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(values, property))
      _setActorValue(actor, property, values[property]);
  }
}

function _cancelAnimation(record, runCallback = true, disconnectSignal = true) {
  if (!record || record.cancelled) return;

  record.cancelled = true;

  if (record.sourceId) {
    GLib.source_remove(record.sourceId);
    record.sourceId = 0;
  }

  if (disconnectSignal && record.destroyId) {
    record.actor.disconnect(record.destroyId);
    record.destroyId = 0;
  }

  if (_animationRecords.get(record.actor) === record)
    _animationRecords.delete(record.actor);

  if (runCallback) record.options.onCancel?.(record.actor);
}

function _finishAnimation(record) {
  record.sourceId = 0;

  if (record.destroyId) {
    record.actor.disconnect(record.destroyId);
    record.destroyId = 0;
  }

  if (_animationRecords.get(record.actor) === record)
    _animationRecords.delete(record.actor);

  if (record.options.fill === "none")
    _applyAnimationValues(record.actor, record.originalValues);

  record.options.onComplete?.(record.actor);
}

function _cancelAllAnimations() {
  for (const record of [..._animationRecords.values()])
    _cancelAnimation(record, true);

  _animationRecords.clear();
}

function Oanimate(el, from = {}, to = {}, options = {}) {
  if (!el) return { cancel() {} };

  _cancelAnimation(_animationRecords.get(el), true);

  const duration = Math.max(options.duration ?? 250, 0);
  const delay = Math.max(options.delay ?? 0, 0);
  const fill = options.fill ?? "none";
  const easing = options.easing ?? "ease-out";
  const properties = ANIMATABLE_PROPERTIES.filter(
    (property) =>
      Object.prototype.hasOwnProperty.call(from, property) ||
      Object.prototype.hasOwnProperty.call(to, property),
  );

  const originalValues = {};
  const fromValues = {};
  const toValues = {};

  for (const property of properties) {
    originalValues[property] = _getActorValue(el, property);
    fromValues[property] = Object.prototype.hasOwnProperty.call(from, property)
      ? from[property]
      : originalValues[property];
    toValues[property] = Object.prototype.hasOwnProperty.call(to, property)
      ? to[property]
      : fromValues[property];
  }

  const record = {
    actor: el,
    cancelled: false,
    destroyId: 0,
    fill,
    fromValues,
    options: { ...options, fill, easing },
    originalValues,
    sourceId: 0,
    startTime: GLib.get_monotonic_time() / 1000 + delay,
    toValues,
    token: Symbol("Oanimate"),
  };

  record.destroyId = el.connect("destroy", () => {
    _cancelAnimation(record, true, false);
  });

  _animationRecords.set(el, record);

  record.sourceId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    FRAME_INTERVAL_MS,
    () => {
      if (record.cancelled) return GLib.SOURCE_REMOVE;

      const now = GLib.get_monotonic_time() / 1000;
      if (now < record.startTime) return GLib.SOURCE_CONTINUE;

      const rawProgress =
        duration === 0 ? 1 : _clamp01((now - record.startTime) / duration);
      const easedProgress = _easeProgress(easing, rawProgress);
      const values = {};

      for (const property of properties) {
        const start = fromValues[property];
        const end = toValues[property];
        values[property] = start + (end - start) * easedProgress;
      }

      _applyAnimationValues(el, values);
      record.options.onUpdate?.(el, easedProgress, rawProgress);

      if (rawProgress >= 1) {
        _finishAnimation(record);
        return GLib.SOURCE_REMOVE;
      }

      return GLib.SOURCE_CONTINUE;
    },
  );

  GLib.Source.set_name_by_id(record.sourceId, "[Private Mode] Oanimate");

  return {
    token: record.token,
    cancel: () => _cancelAnimation(record, true),
  };
}

const PrivateModeToggle = GObject.registerClass(
  class PrivateModeToggle extends QuickSettings.QuickToggle {
    constructor(extension) {
      super({
        title: "Private mode",
        subtitle: "Off",
        gicon: _getPrivateModeIcon(extension),
        toggleMode: true,
      });

      this._extension = extension;
      this._settings = new Gio.Settings({
        schema_id: "org.gnome.desktop.interface",
      });
      this._icon?.set_pivot_point?.(0.5, 0.5);
      this._icon?.set_scale?.(1, 1);
      this._icon?.add_style_class_name?.("private-mode-symbolic-icon");

      this._clickedId = this.connect("clicked", () => {
        this._extension.requestPrivateMode(this.checked);
      });
      this._settingsChangedId = this._settings.connect(
        "changed::color-scheme",
        () => this._syncIcon(),
      );
      this._stSettingsChangedId = St.Settings.get().connect(
        "notify::color-scheme",
        () => this._syncIcon(),
      );
    }

    _syncIcon() {
      this.gicon = _getPrivateModeIcon(this._extension, this._settings);
    }

    playToggleAnimation() {
      const actor = this._icon ?? this;
      actor.set_pivot_point?.(0.5, 0.5);

      Oanimate(
        actor,
        {},
        { scale: 1.12 },
        {
          duration: TOGGLE_DURATION / 2,
          easing: CSS_CUBIC,
          fill: "forwards",
          onComplete: () => {
            Oanimate(
              actor,
              {},
              { scale: 1 },
              {
                duration: TOGGLE_DURATION / 2,
                easing: CSS_CUBIC,
                fill: "forwards",
              },
            );
          },
        },
      );
    }

    setPrivateState(enabled) {
      this.checked = enabled;
      this.subtitle = enabled ? "On" : "Off";
    }

    setBusy(busy) {
      this.reactive = !busy;
      this.can_focus = !busy;
    }

    destroy() {
      if (this._clickedId) {
        this.disconnect(this._clickedId);
        this._clickedId = 0;
      }

      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
      }

      if (this._stSettingsChangedId) {
        St.Settings.get().disconnect(this._stSettingsChangedId);
        this._stSettingsChangedId = 0;
      }

      this._settings?.run_dispose();
      this._settings = null;
      this._extension = null;

      super.destroy();
    }
  },
);

const PrivateModeIndicator = GObject.registerClass(
  class PrivateModeIndicator extends QuickSettings.SystemIndicator {
    constructor(extension) {
      super();

      this._extension = extension;
      this._settings = new Gio.Settings({
        schema_id: "org.gnome.desktop.interface",
      });

      this._indicator = this._addIndicator();
      this._indicator.gicon = _getPrivateModeIcon(extension, this._settings);
      this._indicator.add_style_class_name("privacy-indicator");
      this._indicator.add_style_class_name("private-mode-symbolic-icon");
      this._indicator.visible = false;

      this._toggle = new PrivateModeToggle(extension);
      this.quickSettingsItems.push(this._toggle);

      this._settingsChangedId = this._settings.connect(
        "changed::color-scheme",
        () => this._syncIcon(),
      );
      this._stSettingsChangedId = St.Settings.get().connect(
        "notify::color-scheme",
        () => this._syncIcon(),
      );
    }

    _syncIcon() {
      const icon = _getPrivateModeIcon(this._extension, this._settings);
      this._indicator.gicon = icon;
      this._toggle.gicon = icon;
    }

    setPrivateState(enabled) {
      this._indicator.visible = enabled;
      this._toggle.setPrivateState(enabled);
    }

    playToggleAnimation() {
      this._toggle.playToggleAnimation();
    }

    setBusy(busy) {
      this._toggle.setBusy(busy);
    }

    destroy() {
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
      }

      if (this._stSettingsChangedId) {
        St.Settings.get().disconnect(this._stSettingsChangedId);
        this._stSettingsChangedId = 0;
      }

      for (const item of this.quickSettingsItems) item.destroy();

      this._settings?.run_dispose();
      this._settings = null;
      this._extension = null;

      super.destroy();
    }
  },
);

export default class PrivateModeExtension extends Extension {
  enable() {
    _cancelAllAnimations();

    this._enabled = true;
    this._overlay = null;
    this._overlayAnimation = null;
    this._overlayDestroySourceId = 0;
    this._privateEnabled = false;
    this._busy = false;
    this._requestSerial = 0;
    this._subprocesses = new Set();
    this._cancelledSubprocesses = new WeakSet();

    this._indicator = new PrivateModeIndicator(this);
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
  }

  disable() {
    this._enabled = false;
    this._requestSerial++;

    this._cancelRunningCommands();
    this._destroyOverlay();

    this._indicator?.destroy();
    this._indicator = null;

    _cancelAllAnimations();
  }

  requestPrivateMode(enabled) {
    if (!this._enabled) return;

    const request = enabled
      ? this.privateModeEnabled()
      : this.privateModeDisabled();

    request.catch((error) => {
      if (this._enabled)
        Main.notify(
          "Private Mode",
          `Failed to update private mode: ${error.message}`,
        );
    });
  }

  async privateModeEnabled() {
    await this._runPrivateModeChange(true);
  }

  async privateModeDisabled() {
    await this._runPrivateModeChange(false);
  }

  async _runPrivateModeChange(enabled) {
    const requestId = ++this._requestSerial;
    const previousEnabled = this._privateEnabled;

    if (this._busy) {
      this._setPrivateState(previousEnabled);
      return;
    }

    this._busy = true;
    this._setBusy(true);
    this._cancelRunningCommands();
    this._setPrivateState(previousEnabled);

    try {
      const modprobePath = this._getModprobePath();
      if (!modprobePath) {
        Main.notify(
          "Private Mode",
          "modprobe not found, camera toggle unavailable",
        );
      }

      let cameraSucceeded = false;
      if (modprobePath) {
        const cameraResult = await this._runCommand(
          this._cameraCommand(enabled, modprobePath),
          "Camera",
          { notifyOnFailure: false },
        );

        if (!this._enabled || requestId !== this._requestSerial) return;

        if (!cameraResult.succeeded) {
          this._setPrivateState(previousEnabled);
          if (cameraResult.exitStatus !== PKEXEC_CANCEL_STATUS) {
            Main.notify(
              "Private Mode",
              `Camera command failed: ${cameraResult.errorMessage || `exit status ${cameraResult.exitStatus ?? "unknown"}`}`,
            );
          }
          return;
        }

        cameraSucceeded = true;
      }

      const results = await this._runPrivacyCommands(enabled);

      if (!this._enabled || requestId !== this._requestSerial) return;

      const anySucceeded =
        cameraSucceeded || results.some((result) => result.succeeded);
      if (!anySucceeded) {
        this._setPrivateState(previousEnabled);
        return;
      }

      this._setPrivateState(enabled);
      if (enabled) {
        this._indicator?.playToggleAnimation();
        await this._showOverlay(enabled);
      }
    } finally {
      if (this._enabled && requestId === this._requestSerial) {
        this._busy = false;
        this._setBusy(false);
      }
    }
  }

  _runPrivacyCommands(enabled) {
    const commands = [
      [this._microphoneCommand(enabled), "Microphone"],
      [this._locationCommand(enabled), "Location"],
    ];

    return Promise.all(
      commands.map(([argv, label]) =>
        this._runCommand(argv, label, {
          notifyOnFailure: true,
        }),
      ),
    );
  }

  _setBusy(busy) {
    this._indicator?.setBusy(busy);
  }

  _setPrivateState(enabled) {
    this._privateEnabled = enabled;
    this._indicator?.setPrivateState(enabled);
  }

  _microphoneCommand(enabled) {
    return ["wpctl", "set-mute", "@DEFAULT_AUDIO_SOURCE@", enabled ? "1" : "0"];
  }

  _locationCommand(enabled) {
    return [
      "gsettings",
      "set",
      "org.gnome.system.location",
      "enabled",
      enabled ? "false" : "true",
    ];
  }

  _getModprobePath() {
    return MODPROBE_PATHS.find((path) =>
      GLib.file_test(path, GLib.FileTest.EXISTS | GLib.FileTest.IS_EXECUTABLE),
    );
  }

  _cameraCommand(enabled, modprobePath) {
    if (!modprobePath) return null;

    return enabled
      ? ["pkexec", modprobePath, "-r", "uvcvideo"]
      : ["pkexec", modprobePath, "uvcvideo"];
  }

  _runCommand(argv, label, options = {}) {
    const notifyOnFailure = options.notifyOnFailure ?? true;

    return new Promise((resolve) => {
      let subprocess;

      try {
        subprocess = Gio.Subprocess.new(
          argv,
          Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE,
        );
      } catch (error) {
        if (this._enabled && notifyOnFailure)
          Main.notify(
            "Private Mode",
            `${label} command failed: ${error.message}`,
          );
        resolve({
          errorMessage: error.message,
          exitStatus: null,
          succeeded: false,
        });
        return;
      }

      this._subprocesses.add(subprocess);
      subprocess.wait_check_async(null, (proc, result) => {
        this._subprocesses.delete(proc);

        let succeeded = false;
        let errorMessage = "";
        let exitStatus = null;
        try {
          succeeded = proc.wait_check_finish(result);
        } catch (error) {
          errorMessage = error.message;
          if (
            this._enabled &&
            notifyOnFailure &&
            !this._cancelledSubprocesses.has(proc)
          )
            Main.notify(
              "Private Mode",
              `${label} command failed: ${error.message}`,
            );
        }

        if (proc.get_if_exited()) exitStatus = proc.get_exit_status();

        resolve({
          errorMessage,
          exitStatus,
          succeeded,
        });
      });
    });
  }

  _cancelRunningCommands() {
    if (!this._subprocesses) return;

    for (const subprocess of this._subprocesses) {
      this._cancelledSubprocesses?.add(subprocess);
      subprocess.force_exit();
    }

    this._subprocesses.clear();
  }

  _showOverlay(enabled) {
    this._destroyOverlay();

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return Promise.resolve();

    const overlay = new St.Widget({
      style_class: "private-mode-overlay",
      reactive: false,
      layout_manager: new Clutter.FixedLayout(),
    });
    overlay.set_position(monitor.x, monitor.y);
    overlay.set_size(monitor.width, monitor.height);
    overlay.set_clip(0, 0, monitor.width, monitor.height);

    const desktopBackground = this._getPrimaryBackgroundActor();
    const backgroundState = desktopBackground
      ? {
          actor: desktopBackground,
          pivotPoint: desktopBackground.pivotPoint,
          scaleX: desktopBackground.scaleX,
          scaleY: desktopBackground.scaleY,
        }
      : null;
    desktopBackground?.set_pivot_point?.(0.5, 0.5);

    let backgroundShaderActor = null;
    let backgroundShaderEffect = null;
    backgroundShaderActor = _createBackgroundShaderActor(monitor);
    if (backgroundShaderActor) {
      backgroundShaderEffect = _createBackgroundShaderEffect(
        this,
        monitor.width,
        monitor.height,
      );
      if (backgroundShaderEffect)
        backgroundShaderActor.add_effect_with_name(
          "private-mode-background-wave",
          backgroundShaderEffect,
        );

      overlay.add_child(backgroundShaderActor);
    }

    const waterOverlay = new St.Widget({
      style_class: "private-mode-water-overlay",
      reactive: false,
    });
    waterOverlay.set_position(0, 0);
    waterOverlay.set_size(monitor.width, monitor.height);
    waterOverlay.opacity = 0;
    overlay.add_child(waterOverlay);

    const iconSize = monitor.height;
    const icon = new St.Icon({
      style_class: "private-mode-overlay-icon",
      gicon: _getGradientIcon(this),
      icon_size: iconSize,
    });
    const iconFrame = new St.Bin({
      style_class: "private-mode-svg-frame",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      child: icon,
    });
    iconFrame.set_position(
      Math.floor((monitor.width - iconSize) / 2),
      Math.floor((monitor.height - iconSize) / 2),
    );
    iconFrame.set_size(iconSize, iconSize);
    iconFrame.set_pivot_point(0.5, 0.5);
    iconFrame.set_scale(0, 0);
    iconFrame.opacity = 0;
    icon.set_pivot_point?.(0.5, 0.5);
    overlay.add_child(iconFrame);

    Main.layoutManager.uiGroup.add_child(overlay);
    this._overlay = overlay;

    return new Promise((resolve) => {
      let resolved = false;
      const destroyOverlay = () => {
        if (this._overlayDestroySourceId) {
          GLib.source_remove(this._overlayDestroySourceId);
          this._overlayDestroySourceId = 0;
        }

        this._overlay?.destroy();
        this._overlay = null;
      };
      const finish = (immediate = false) => {
        if (resolved) return;
        resolved = true;

        waterOverlay.opacity = 0;
        if (backgroundShaderActor) backgroundShaderActor.opacity = 0;
        if (backgroundShaderEffect) {
          backgroundShaderEffect.set_enabled(false);
          _setShaderFloat(backgroundShaderEffect, "amount", 0.0);
          _setShaderFloat(backgroundShaderEffect, "release", 1.0);
        }

        if (backgroundState) {
          backgroundState.actor.set_scale(
            backgroundState.scaleX,
            backgroundState.scaleY,
          );
          backgroundState.actor.set_pivot_point?.(
            backgroundState.pivotPoint?.x ?? 0,
            backgroundState.pivotPoint?.y ?? 0,
          );
        }
        this._overlayAnimation = null;

        if (immediate) {
          destroyOverlay();
        } else {
          this._overlayDestroySourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            OVERLAY_DESTROY_DELAY,
            () => {
              destroyOverlay();
              return GLib.SOURCE_REMOVE;
            },
          );
          GLib.Source.set_name_by_id(
            this._overlayDestroySourceId,
            "[Private Mode] destroy overlay after fade",
          );
        }

        resolve();
      };

      this._overlayAnimation = Oanimate(
        waterOverlay,
        { opacity: 0 },
        { opacity: 0 },
        {
          duration: OVERLAY_DURATION,
          easing: CSS_CUBIC,
          fill: "forwards",
          onUpdate: (actor, _progress, rawProgress) => {
            actor.opacity = Math.round(_waterOverlayOpacity(rawProgress) * 255);
            const shaderState = _backgroundShaderState(rawProgress);

            if (backgroundShaderEffect) {
              backgroundShaderEffect.set_enabled(shaderState.active);
              _setShaderFloat(
                backgroundShaderEffect,
                "amount",
                shaderState.amount,
              );
              _setShaderFloat(
                backgroundShaderEffect,
                "release",
                shaderState.release,
              );
              _setShaderFloat(
                backgroundShaderEffect,
                "time",
                (rawProgress * OVERLAY_DURATION) / 1000,
              );
            }
            if (backgroundShaderActor)
              backgroundShaderActor.opacity = shaderState.active ? 255 : 0;

            const iconState = _overlayIconState(rawProgress);
            if (backgroundState) {
              const wallpaperScale = _wallpaperScale(rawProgress);
              backgroundState.actor.set_scale(
                backgroundState.scaleX * wallpaperScale,
                backgroundState.scaleY * wallpaperScale,
              );
            }
            iconFrame.opacity = Math.round(iconState.opacity * 255);
            iconFrame.set_scale(iconState.scale, iconState.scale);
          },
          onComplete: () => finish(false),
          onCancel: () => finish(true),
        },
      );
    });
  }

  _getPrimaryBackgroundActor() {
    const layoutManager = Main.layoutManager;
    const primaryIndex = layoutManager.primaryIndex;
    if (primaryIndex == null || primaryIndex < 0) return null;

    return layoutManager._bgManagers?.[primaryIndex]?.backgroundActor ?? null;
  }

  _destroyOverlay() {
    if (this._overlayDestroySourceId) {
      GLib.source_remove(this._overlayDestroySourceId);
      this._overlayDestroySourceId = 0;
    }

    this._overlayAnimation?.cancel();
    this._overlayAnimation = null;

    this._overlay?.destroy();
    this._overlay = null;
  }
}

function _overlayIconState(progress) {
  const elapsed = progress * OVERLAY_DURATION;

  if (elapsed <= ICON_ANIMATION_DELAY)
    return { scale: ICON_START_SCALE, opacity: 0 };

  const inElapsed = elapsed - ICON_ANIMATION_DELAY;
  if (inElapsed < ICON_ANIMATION_IN_DURATION) {
    const eased = _cubicBezierProgress(
      CSS_CUBIC,
      inElapsed / ICON_ANIMATION_IN_DURATION,
    );
    return {
      scale: ICON_START_SCALE + (ICON_HOLD_SCALE - ICON_START_SCALE) * eased,
      opacity: eased,
    };
  }

  const outElapsed = inElapsed - ICON_ANIMATION_IN_DURATION;
  if (outElapsed < ICON_ANIMATION_OUT_DURATION) {
    const outProgress = outElapsed / ICON_ANIMATION_OUT_DURATION;
    const eased = _cubicBezierProgress(CSS_CUBIC, outProgress);
    const fadeProgress = outProgress <= 0.5 ? 0 : (outProgress - 0.5) / 0.5;

    return {
      scale: ICON_HOLD_SCALE + (ICON_END_SCALE - ICON_HOLD_SCALE) * eased,
      opacity: 1 - _cubicBezierProgress(CSS_CUBIC, fadeProgress),
    };
  }

  return { scale: ICON_END_SCALE, opacity: 0 };
}

function _waterOverlayOpacity(progress) {
  if (progress <= 0) return 0;
  if (progress < 0.3) return _cubicBezierProgress(CSS_CUBIC, progress / 0.3);
  if (progress <= 0.6) return 1;
  if (progress < 1)
    return 1 - _cubicBezierProgress(CSS_CUBIC, (progress - 0.6) / 0.4);
  return 0;
}

function _backgroundShaderState(progress) {
  const elapsed = progress * OVERLAY_DURATION;

  if (elapsed <= 0) return { active: false, amount: 0, release: 0 };

  if (elapsed < BACKGROUND_SHADER_GROW_DURATION) {
    const eased = _cubicBezierProgress(
      CSS_CUBIC,
      elapsed / BACKGROUND_SHADER_GROW_DURATION,
    );
    return { active: true, amount: eased, release: 0 };
  }

  if (elapsed < BACKGROUND_SHADER_RETURN_START)
    return { active: true, amount: 1, release: 0 };

  const returnElapsed = elapsed - BACKGROUND_SHADER_RETURN_START;
  if (returnElapsed < BACKGROUND_SHADER_RETURN_DURATION) {
    const eased = _cubicBezierProgress(
      CSS_CUBIC,
      returnElapsed / BACKGROUND_SHADER_RETURN_DURATION,
    );
    return { active: true, amount: 1, release: eased };
  }

  return { active: false, amount: 0, release: 1 };
}

function _wallpaperScale(progress) {
  const elapsed = progress * OVERLAY_DURATION;

  if (elapsed <= WALLPAPER_ANIMATION_DELAY) return WALLPAPER_START_SCALE;

  const inElapsed = elapsed - WALLPAPER_ANIMATION_DELAY;
  if (inElapsed < WALLPAPER_ANIMATION_IN_DURATION) {
    const eased = _cubicBezierProgress(
      CSS_CUBIC,
      inElapsed / WALLPAPER_ANIMATION_IN_DURATION,
    );
    return (
      WALLPAPER_START_SCALE +
      (WALLPAPER_PEAK_SCALE - WALLPAPER_START_SCALE) * eased
    );
  }

  const outElapsed = inElapsed - WALLPAPER_ANIMATION_IN_DURATION;
  if (outElapsed < WALLPAPER_ANIMATION_OUT_DURATION) {
    const eased = _cubicBezierProgress(
      CSS_CUBIC,
      outElapsed / WALLPAPER_ANIMATION_OUT_DURATION,
    );
    return (
      WALLPAPER_PEAK_SCALE -
      (WALLPAPER_PEAK_SCALE - WALLPAPER_START_SCALE) * eased
    );
  }
  return WALLPAPER_START_SCALE;
}
