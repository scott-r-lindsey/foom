/** Baked R3 light and geodesic lookup, never runtime ray tracing. */
const SIZE = 512;
const FOV = 14;
const SHADOW_RADIUS = 3 * Math.sqrt(3);
const VERTEX = `attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }`;
// Only a three-shadow-radius disc is replaced. The source is the current
// procedural star layers, captured before the foreground trail and rocket.
export const LENS_RADIUS = 3;
const FRAGMENT = `precision highp float;
varying vec2 uv;
uniform sampler2D lens, emission, sky;
uniform vec2 viewport, centre;
uniform float radius;
vec4 starlight(vec2 pixel) {
  vec2 p = pixel / viewport;
  float inside = step(0., min(p.x, p.y)) * step(max(p.x, p.y), 1.);
  // A small reconstruction filter softens magnified streak edges rather than
  // adding a uniform white ring. Brightness and colour come from actual stars.
  vec2 d = .6 / viewport;
  return inside * (texture2D(sky, p) * .5
    + texture2D(sky, p + vec2(d.x, 0.)) * .125
    + texture2D(sky, p - vec2(d.x, 0.)) * .125
    + texture2D(sky, p + vec2(0., d.y)) * .125
    + texture2D(sky, p - vec2(0., d.y)) * .125);
}
void main() {
  vec2 offset = (vec2(uv.x, 1. - uv.y) - .5) * 6.;
  vec2 pixel = centre + offset * radius;
  vec2 q = offset * ${String(SHADOW_RADIUS)};
  vec2 local = q / 28. + .5;
  float weight = 1. - smoothstep(2.1, 3., length(offset));
  vec2 source = pixel;
  float visible = 1.;
  float shadow = 0.;
  vec3 light = vec3(0.);
  if (min(local.x, local.y) >= 0. && max(local.x, local.y) <= 1.) {
    vec4 mx = texture2D(lens, vec2(local.x * .5, local.y));
    vec4 my = texture2D(lens, vec2(.5 + local.x * .5, local.y));
    vec2 bent = vec2(dot(mx.rg, vec2(65280., 255.)), dot(my.rg, vec2(65280., 255.))) / 65535. * 512. - 256.;
    // The offline map's y axis points up; screen coordinates point down.
    bent.y = -bent.y;
    // Return to the original coordinates before the finite lookup ends, so
    // even a star crossing its rectangular boundary cannot reveal a box.
    float edge = 1. - smoothstep(.4, .5, max(abs(local.x - .5), abs(local.y - .5)));
    source = mix(pixel, centre + bent / ${String(SHADOW_RADIUS)} * radius, edge);
    visible = mix(1., mx.b, edge);
    shadow = my.b;
    light = texture2D(emission, local).rgb * weight * edge;
  }
  vec4 original = texture2D(sky, pixel / viewport);
  vec4 stars = mix(original, starlight(source) * visible, weight);
  stars *= 1. - shadow;
  gl_FragColor = vec4(light + stars.rgb,
    max(max(stars.a, shadow), max(light.r, max(light.g, light.b))));
}`;

export interface Singularity {
  draw: (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    x: number,
    y: number,
    radius: number,
    time: number,
    dark: boolean,
  ) => void;
  dispose: () => void;
}

/** One owned context per visible surface; the fallback is the same baked view. */
export function createSingularity(repaint: () => void): Singularity {
  const still = new Image();
  const images = ["lens", "emission"].map((name) => ({ name, image: new Image() }));
  const surface = document.createElement("canvas");
  const gl = surface.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    depth: false,
    antialias: false,
  });
  let disposed = false;
  let ready = false;
  const textures: WebGLTexture[] = [];
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const fallback = () => {
    if (!disposed) repaint();
  };
  still.onload = fallback;
  still.src = "art/singularity.png";
  const shader = (type: number, source: string) => {
    const result = gl?.createShader(type);
    if (!gl || !result) return null;
    shaders.push(result);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    return gl.getShaderParameter(result, gl.COMPILE_STATUS) ? result : null;
  };
  const vertex = gl && shader(gl.VERTEX_SHADER, VERTEX);
  const fragment = gl && shader(gl.FRAGMENT_SHADER, FRAGMENT);
  if (gl && vertex && fragment) {
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const sky = gl.createTexture();
      textures.push(sky);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, sky);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, "sky"), 2);
      let loaded = 0;
      const linked = program;
      images.forEach(({ image, name }, index) => {
        image.onload = () => {
          if (disposed) return;
          const texture = gl.createTexture();
          textures.push(texture);
          gl.activeTexture(gl.TEXTURE0 + index);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          const filter = index === 0 ? gl.NEAREST : gl.LINEAR;
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
          const wrap = gl.CLAMP_TO_EDGE;
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
          gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.uniform1i(gl.getUniformLocation(linked, name), index);
          ready = ++loaded === 2;
          fallback();
        };
        image.src = `art/${name}.png`;
      });
    }
  }
  const lost = (event: Event) => {
    event.preventDefault();
    ready = false;
    fallback();
  };
  surface.addEventListener("webglcontextlost", lost);
  return {
    draw(ctx, w, h, x, y, radius, _time, _dark) {
      if (disposed) return;
      if (gl && program && buffer && ready && !gl.isContextLost()) {
        const side = radius * 2 * LENS_RADIUS;
        const pixels = Math.max(1, Math.min(1440, Math.ceil(side)));
        if (surface.width !== pixels || surface.height !== pixels) {
          surface.width = pixels;
          surface.height = pixels;
        }
        // Capture only the already-drawn original sky, never a second starfield.
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, textures[0] ?? null);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
        gl.viewport(0, 0, pixels, pixels);
        gl.uniform2f(gl.getUniformLocation(program, "viewport"), w, h);
        gl.uniform2f(gl.getUniformLocation(program, "centre"), x, y);
        gl.uniform1f(gl.getUniformLocation(program, "radius"), radius);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, radius * LENS_RADIUS, 0, Math.PI * 2);
        ctx.clip();
        // Replace only this disc; its outer band blends back to the source sky.
        ctx.clearRect(x - side / 2, y - side / 2, side, side);
        ctx.drawImage(surface, x - side / 2, y - side / 2, side, side);
        ctx.restore();
      } else if (still.complete && still.naturalWidth === SIZE) {
        const side = (radius * 2 * FOV) / SHADOW_RADIUS;
        ctx.drawImage(still, x - side / 2, y - side / 2, side, side);
      } else {
        ctx.fillStyle = "#06050B";
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    dispose() {
      disposed = true;
      still.onload = null;
      for (const { image } of images) image.onload = null;
      surface.removeEventListener("webglcontextlost", lost);
      for (const texture of textures) gl?.deleteTexture(texture);
      for (const item of shaders) gl?.deleteShader(item);
      if (buffer) gl?.deleteBuffer(buffer);
      if (program) gl?.deleteProgram(program);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
