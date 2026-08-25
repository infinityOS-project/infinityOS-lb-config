uniform sampler2D cogl_sampler;

uniform float resolution_x;
uniform float resolution_y;
uniform float amount;
uniform float release;
uniform float peak_scale;
uniform float wave_width;
uniform float time;

float saturate(float value) {
    return clamp(value, 0.0, 1.0);
}

float easeOutCubic(float value) {
    float t = saturate(value);
    return 1.0 - pow(1.0 - t, 3.0);
}

vec2 safeUv(vec2 uv, vec2 resolution) {
    vec2 margin = vec2(1.2) / resolution;
    return clamp(uv, margin, vec2(1.0) - margin);
}

void main() {
    vec2 resolution = vec2(max(resolution_x, 1.0), max(resolution_y, 1.0));
    vec2 uv = cogl_tex_coord_in[0].st;
    vec2 center = vec2(0.5);
    vec2 fromCenter = uv - center;

    float growAmount = saturate(amount);
    float releaseAmount = saturate(release);

    if (growAmount <= 0.001 && releaseAmount <= 0.001) {
        cogl_color_out = vec4(0.0);
        return;
    }

    vec2 aspect = vec2(resolution.x / resolution.y, 1.0);
    float maxRadius = length(vec2(0.5) * aspect);
    float radius = saturate(length(fromCenter * aspect) / max(maxRadius, 0.001));

    float localRelease = 0.0;
    if (releaseAmount > 0.001) {
        float waveWidth = max(wave_width, 0.001);
        localRelease = smoothstep(
            max(radius - waveWidth, 0.0),
            min(radius + waveWidth, 1.0),
            releaseAmount
        );
    }

    float scale;
    if (releaseAmount > 0.001) {
        scale = mix(peak_scale, 1.0, easeOutCubic(localRelease));
    } else {
        scale = mix(1.0, peak_scale, easeOutCubic(growAmount));
    }

    vec2 sampleUv = center + fromCenter / max(scale, 0.001);
    vec4 color = texture2D(cogl_sampler, safeUv(sampleUv, resolution));

    cogl_color_out = vec4(color.rgb, 1.0) * cogl_color_in;
}
