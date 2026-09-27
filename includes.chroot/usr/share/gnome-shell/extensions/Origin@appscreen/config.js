"use strict";


export const other_duration = 150;
export const other_duration_2 = 250;
export const other_cubic = [0.25, 0.1, 0.25, 1];

export const FRAME_INTERVAL = 1000 / 60; // 60 fps
export const PROGRESSED_CUBIC_STEP_MS = FRAME_INTERVAL;
export const PROGRESSED_CUBIC_MIN_STEPS = 240;
export const ICON_TRACKING_SMOOTH = 0.42;
export const WORKSPACE_SWITCH_UNMINIMIZE_WINDOW = 900;

export const stageOn_duration_minimize = 380;
export const stageOn_duration_unminimize = 470;
export const stageOn_cubic_minimize = [0.24, 0.54, 0.23, 0.97];
export const stageOn_cubic_uminimize = [0.25, 1.2, 0.39, 1];
export const stageOff_duration_minimize = 400;
export const stageOff_duration_unminimize = 450;
export const stageOff_cubic_minimize = [0.3, 0.6, 0.1, 1];
export const stageOff_cubic_uminimize = [0.25, 1.2, 0.39, 1];
export const DURATION_drag_out_unminimize = stageOn_duration_unminimize;
export const drag_duration = 250;
export const STAGE_CROSSFADE_DURATION = 50;

export const minimizeOpacityDelay = stageOff_duration_minimize * 0.3;
export const minimizeOpacityIcon = stageOff_duration_minimize * 0.25;

export const unminimizeOpacityIcon = 0;
export const unminimizeOpacityDelayIcon = 0;

//stage edge
export const STAGE_EDGE_SIZE = 180;
export const STAGE_LEFT_OFFSET = 18;
export const STAGE_ROTATION_Y = 0;

export const FALLBACK_ICON_SIZE = 48;
export const STAGE_GAP = 15;
export const STAGE_COVER_EXTRA = 20;
export const STAGE_RESERVED_WIDTH =
  STAGE_LEFT_OFFSET + STAGE_EDGE_SIZE + STAGE_COVER_EXTRA;
export const STAGE_SHADOW_PAD = 0;
export const STAGE_SHADOW_STYLE =
  "border-radius: 22px;" + "box-shadow: rgba(0, 0, 0, 0.5) 0px 0px 25px -7px;";
export const STAGE_ACTIVE_OPACITY = 204;
export const STAGE_ACTIVE_DURATION = 200;
export const STAGE_SHOW_DELAY = 0;
export const STAGE_SHOW_HIDE_DELAY_RATIO = 30;
export const STAGE_EDGE_REVEAL_SIZE = 5;
export const STAGE_EDGE_REVEAL_DELAY = 0;
export const STAGE_DRAG_THRESHOLD = 25;
export const STAGE_HEIGHT_RATIO = 0.9;
export const STAGE_MIN_SCROLL_SCALE = 0.5;
export const STAGE_SCROLL_STEP = 90;
export const WINDOW_KEEP_ONSCREEN_PADDING = 8;
export const WINDOW_KEEP_ONSCREEN_DURATION = 400;
export const STAGE_INFO_ICON_SIZE = 20;
export const STAGE_INFO_GAP = 6;
export const STAGE_INFO_TOP_MARGIN = 0;
export const STAGE_INFO_ROW_HEIGHT = STAGE_INFO_TOP_MARGIN + STAGE_INFO_ICON_SIZE + 2;
export const STAGE_INFO_LABEL_DURATION = 150;
export const STAGE_INFO_LABEL_STYLE =
  "font-size: 15px;" +
  "font-weight: 600;" +
  "color: rgba(255, 255, 255, 0.94);" +
  "text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75);";
export const STAGE_HOVER_SCALE = 1.1;

// for overview icon kiêm luôn transition mặc định.
export const START_SCALE = 3;
export const DURATION = 400;
export const DELAY_RATIO = 330;
export const CUBIC_BEZIER = [0.25, 1.25, 0.39, 1]; // for scale icon
export const DEFAULT_STAGE_ICON_NAME = "view-grid-symbolic";
export const CENTRE_STAGE_ICON_SCALE = 1;
