# Origin extension architecture

`extension.js` is deliberately small: it initializes state, enables/disables the
extension, and composes the mixins below. All mixins operate on the same
`OriginAppGrid` instance, so `this._stageEntries`, animation tokens, and signal
IDs retain their original ownership and lifetime.

| File | Responsibility |
| --- | --- |
| `config.js` | Central animation, layout, timing, and visual constants. |
| `animationEngine.js` | Cubic-Bezier lookup tables and frame-based actor animation primitives. |
| `remakeMinimizeAnim.js` | Window/dock-icon discovery plus minimize and reverse animation. |
| `remakeUnminimizeAnim.js` | Unminimize completion, cancellation, and actor cleanup. |
| `stageManager.js` | Stage Manager mode, preview surfaces, layouts, visibility, and restoration. |
| `stageManagerStageScroll.js` | Scroll, pointer capture, hit testing, drag/reorder, and drag-out logic. |
| `stageManagerQuickSettings.js` | Quick Settings indicator and toggle. |
| `helper.js` | Small stateless helpers shared by subsystems. |

## Navigation guide

- Change timing/easing: start in `config.js`, then `animationEngine.js`.
- Debug a normal minimize/unminimize transition: begin at
  `_connectWindowAnimations()` in `remakeMinimizeAnim.js`.
- Debug Stage Manager placement or previews: begin at `_setStageMode()` and
  `_relayoutStage()` in `stageManager.js`.
- Debug input, scrolling, or a dragged stage: use `stageManagerStageScroll.js`.

The mixin order in `extension.js` is intentional. Do not convert a method call
such as `this._animateActor(...)` into a cross-module import: keeping it on the
extension instance preserves overridable behaviour and prevents circular module
dependencies.
