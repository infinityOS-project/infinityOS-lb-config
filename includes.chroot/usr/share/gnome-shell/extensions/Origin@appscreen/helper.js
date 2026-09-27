"use strict";
import Clutter from "gi://Clutter";

export function _finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function _nullCloneSources(actor) {
  try {
    if (actor instanceof Clutter.Clone) {
      try {
        actor.set_source(null);
      } catch {}
    }

    for (let child of actor.get_children?.() ?? []) _nullCloneSources(child);
  } catch {}
}

