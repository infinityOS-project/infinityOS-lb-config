import Clutter from "gi://Clutter";

const SOURCE = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float radius;

float circleCoverage(vec2 point, vec2 center, float cornerRadius) {
  float distanceSquared = dot(point - center, point - center);
  float outer = cornerRadius + 0.5;
  float inner = cornerRadius - 0.5;

  if (distanceSquared >= outer * outer)
    return 0.0;
  if (distanceSquared <= inner * inner)
    return 1.0;
  return outer - sqrt(distanceSquared);
}

vec4 getTexture(vec2 uv) {
  uv.x = clamp(uv.x, 2.0 / width, 1.0 - 3.0 / width);
  uv.y = clamp(uv.y, 2.0 / height, 1.0 - 3.0 / height);
  return texture2D(tex, uv);
}

void main() {
  vec2 uv = cogl_tex_coord_in[0].xy;
  vec2 point = uv * vec2(width, height);
  vec2 center;
  float coverage = 1.0;

  if (point.x < radius && point.y < radius) {
    center = vec2(radius + 2.0, radius + 2.0);
    coverage = circleCoverage(point, center, radius);
  } else if (point.x > width - radius && point.y < radius) {
    center = vec2(width - radius - 1.0, radius + 2.0);
    coverage = circleCoverage(point, center, radius);
  } else if (point.x < radius && point.y > height - radius) {
    center = vec2(radius + 2.0, height - radius - 1.0);
    coverage = circleCoverage(point, center, radius);
  } else if (point.x > width - radius && point.y > height - radius) {
    center = vec2(width - radius - 1.0, height - radius - 1.0);
    coverage = circleCoverage(point, center, radius);
  }

  vec4 color = getTexture(uv);
  cogl_color_out = vec4(color.rgb * coverage, min(coverage, color.a));
}
`;

export function addRoundedClipEffect(actor, radius = 24) {
  if (!actor) return null;

  const effect = new Clutter.ShaderEffect();
  effect.set_shader_source(SOURCE);

  const update = () => {
    const width = Math.max(1, actor.width + 3);
    const height = Math.max(1, actor.height + 3);

    effect.set_uniform_value("width", width);
    effect.set_uniform_value("height", height);
    effect.set_uniform_value(
      "radius",
      Math.max(0, Math.min(radius, width / 2, height / 2) - 0.000001),
    );
    effect.queue_repaint();
  };

  const sizeId = actor.connect("notify::size", update);
  update();
  actor.add_effect(effect);

  return { effect, sizeId };
}

export function removeRoundedClipEffect(actor, data) {
  if (!actor || !data) return;

  try {
    actor.remove_effect(data.effect);
  } catch (_) {}

  try {
    actor.disconnect(data.sizeId);
  } catch (_) {}
}
