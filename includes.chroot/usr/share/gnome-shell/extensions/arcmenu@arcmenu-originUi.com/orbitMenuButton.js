import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import Graphene from "gi://Graphene";
import St from "gi://St";

const ORBIT_SPEED = 0.002;
const RADIUS_X_RATIO = 0.9;
const RADIUS_Y_RATIO = 0.30;
const PERSPECTIVE_STRENGTH = 0.4;
const TILT_DEGREES = -22.5;
const SUPERSAMPLE = 1.5;

const BURST_MULTIPLIER = 80;
const FRICTION = 0.92;

export const OrbitMenuButtonWidget = GObject.registerClass(
  class OrbitMenuButtonWidget extends St.Widget {
    _init(iconPaths, iconSize = 24) {
      super._init({
        layout_manager: new Clutter.BinLayout(),
        style_class: "arcmenu-orbit-menu-button",
        reactive: true,
        track_hover: true,
      });

      this._iconSize = iconSize;
      this._angle = 0;
      this._speedMultiplier = 1;
      this._icons = [];

      const footprint = iconSize + iconSize * RADIUS_X_RATIO * 2;
      this.set_size(footprint, iconSize * 2);

      const tiltRad = (TILT_DEGREES * Math.PI) / 180;
      this._cosTilt = Math.cos(tiltRad);
      this._sinTilt = Math.sin(tiltRad);

      this._renderScale = (1 + PERSPECTIVE_STRENGTH) * SUPERSAMPLE;
      const renderSize = Math.ceil(iconSize * this._renderScale);

      for (const path of iconPaths) {
        const icon = new St.Icon({
          gicon: Gio.Icon.new_for_string(path),
          icon_size: renderSize,
          pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        });
        this.add_child(icon);
        this._icons.push(icon);
      }

      this._layout();

      this.connect("destroy", () => this._stopAnimation());
    }

    pulse() {
      this._speedMultiplier = BURST_MULTIPLIER;
    }

    _layout() {
      const n = this._icons.length;
      const radiusX = this._iconSize * RADIUS_X_RATIO;
      const radiusY = this._iconSize * RADIUS_Y_RATIO;

      this._icons.forEach((icon, index) => {
        const itemAngle = this._angle + (index * (Math.PI * 2)) / n;

        let x = Math.cos(itemAngle) * radiusX;
        let y = Math.sin(itemAngle) * radiusY;

        const perspective = 1 + Math.sin(itemAngle) * PERSPECTIVE_STRENGTH;
        x *= perspective;
        y *= perspective;
        const scale = perspective / this._renderScale;

        const tiltedX = x * this._cosTilt - y * this._sinTilt;
        const tiltedY = x * this._sinTilt + y * this._cosTilt;

        icon.set({
          translation_x: tiltedX,
          translation_y: tiltedY,
          scale_x: scale,
          scale_y: scale,
          opacity: Math.round((0.3 + perspective * 0.5) * 255),
        });
        icon._orbitDepth = perspective;
      });

      const sorted = [...this._icons].sort(
        (a, b) => a._orbitDepth - b._orbitDepth
      );
      let previous = null;
      for (const icon of sorted) {
        if (previous) this.set_child_above_sibling(icon, previous);
        previous = icon;
      }
    }

    startAnimation() {
      if (this._animating) return;
      this._animating = true;

      const beginTicking = () => {
        if (this._timeline) return;

        this._timeline = new Clutter.Timeline({
          actor: this,
          duration: 1000,
          repeat_count: -1,
        });
        this._timeline.connect("new-frame", () => {
          this._angle += ORBIT_SPEED * this._speedMultiplier;
          if (this._speedMultiplier > 1) {
            this._speedMultiplier = 1 + (this._speedMultiplier - 1) * FRICTION;
            if (this._speedMultiplier < 1.01) this._speedMultiplier = 1;
          }
          this._layout();
        });
        this._timeline.start();
      };

      if (this.mapped) {
        beginTicking();
      } else {
        this._mappedId = this.connect("notify::mapped", () => {
          if (this.mapped) beginTicking();
        });
      }
    }

    _stopAnimation() {
      this._animating = false;
      if (this._mappedId) {
        this.disconnect(this._mappedId);
        this._mappedId = null;
      }
      if (this._timeline) {
        this._timeline.stop();
        this._timeline = null;
      }
    }

    stopAnimation() {
      this._stopAnimation();
    }
  }
);
