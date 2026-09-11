import type { Camera, Globe } from './geo';

/**
 * The satellite base layer: an equirectangular photograph of the Earth wrapped
 * onto the globe by a fragment shader.
 *
 * This is the half of the hybrid map that MapTap does in Three.js with tiles.
 * Here it is one full-screen quad and about forty lines of GLSL, because the
 * projection is fixed: every pixel of the disc corresponds to exactly one point
 * on the sphere, so the shader can go straight from pixel to latitude and
 * longitude and sample the image. No tile server, no mesh, no scene graph.
 *
 * The one thing that matters above all else is that this agrees with d3 to the
 * pixel. The vector layer drawn on top -- borders, the highlight under the
 * cursor -- is projected by d3, and any disagreement shows up immediately as
 * outlines sliding off their coastlines. So the shader below is not "an
 * orthographic projection", it is a transcription of *d3's* orthographic
 * projection and rotation, and there is a test that holds the two side by side.
 */

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uCentre;     // disc centre, in framebuffer pixels (y up)
uniform float uRadius;    // disc radius, in framebuffer pixels
uniform vec2 uRotation;   // d3's rotate(), as radians: [lambda, phi]
uniform sampler2D uEarth;

out vec4 fragColour;

const float PI = 3.141592653589793;

void main() {
  // Position within the unit disc. d3 maps sin(phi) to *upward* screen
  // distance, and gl_FragCoord.y already points up, so no flip is needed here
  // provided uCentre is given in the same bottom-up space.
  vec2 p = (gl_FragCoord.xy - uCentre) / uRadius;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;

  // Rebuild the point on the sphere facing the viewer. d3's cartesian
  // convention is x = cos(lat)cos(lon), y = cos(lat)sin(lon), z = sin(lat);
  // orthographic projects y to the right and z upward, leaving x as depth.
  vec3 e = vec3(sqrt(max(0.0, 1.0 - r2)), p.x, p.y);

  // Undo d3's rotation. rotate([l, p, 0]) is a turn about z followed by a turn
  // about y, so the inverse is those two, reversed and negated.
  float cl = cos(uRotation.x), sl = sin(uRotation.x);
  float cp = cos(uRotation.y), sp = sin(uRotation.y);

  vec3 t = vec3(cp * e.x + sp * e.z, e.y, -sp * e.x + cp * e.z);
  vec3 g = vec3(cl * t.x + sl * t.y, -sl * t.x + cl * t.y, t.z);

  float lon = atan(g.y, g.x);
  float lat = asin(clamp(g.z, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  // Sampling with an explicit gradient. The longitude seam makes uv jump by a
  // whole turn in one pixel, which the automatic derivative reads as an
  // enormous change and answers with the smallest mip level -- a bright blurred
  // line down the antimeridian. Taking the gradient from a half-turn-shifted
  // copy wherever that is the smaller of the two removes it.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 shifted = vec2(fract(uv.x + 0.5), uv.y);
  vec2 sx = dFdx(shifted), sy = dFdy(shifted);
  if (abs(sx.x) < abs(dx.x)) dx.x = sx.x;
  if (abs(sy.x) < abs(dy.x)) dy.x = sy.x;

  vec3 colour = textureGrad(uEarth, uv, dx, dy).rgb;

  // Feather the very edge so the limb is not a hard staircase.
  float edge = 1.0 - smoothstep(0.985, 1.0, r2);
  fragColour = vec4(colour, edge);
}
`;

export interface RasterGlobe {
  /** Offscreen canvas holding the rendered sphere, to be composited by the 2D layer. */
  readonly canvas: HTMLCanvasElement;
  /** True once an image has been uploaded and there is something to draw. */
  readonly ready: boolean;
  setTexture(image: TexImageSource): void;
  render(globe: Globe, camera: Camera, dpr: number): void;
  destroy(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

/**
 * Set up the raster layer, or return null where it cannot run.
 *
 * A null return is not an error: the game falls back to the vector base map,
 * which is what every previous version used and looks after itself perfectly
 * well. WebGL2 is absent on some older tablets, which is exactly the audience
 * least able to explain a blank screen.
 */
export function createRasterGlobe(): RasterGlobe | null {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
    }
  } catch {
    return null;
  }

  // One quad covering the viewport; all the work happens per fragment.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  const uCentre = gl.getUniformLocation(program, 'uCentre');
  const uRadius = gl.getUniformLocation(program, 'uRadius');
  const uRotation = gl.getUniformLocation(program, 'uRotation');
  const uEarth = gl.getUniformLocation(program, 'uEarth');

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Repeat horizontally: the antimeridian runs through the sampled image, and
  // clamping there would smear the last column across the Pacific.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  let ready = false;

  return {
    canvas,
    get ready() {
      return ready;
    },

    setTexture(image: TexImageSource) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      ready = true;
    },

    render(globe: Globe, camera: Camera, dpr: number) {
      const w = Math.round(globe.width * dpr);
      const h = Math.round(globe.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!ready) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uEarth, 0);

      // d3 places the disc centre at translate() measured downward from the top;
      // the framebuffer measures upward from the bottom.
      gl.uniform2f(uCentre, (globe.width / 2) * dpr, h - (globe.height / 2) * dpr);
      gl.uniform1f(uRadius, globe.baseScale * camera.zoom * dpr);
      // Exactly the rotation applyCamera() gives the d3 projection.
      gl.uniform2f(
        uRotation,
        (-camera.center[0] * Math.PI) / 180,
        (-camera.center[1] * Math.PI) / 180,
      );

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    destroy() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

/** Load the small texture first, then quietly upgrade to the large one. */
export function loadEarthTextures(
  base: string,
  onReady: (image: HTMLImageElement) => void,
): void {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });

  load(`${base}textures/earth-1024.jpg`)
    .then((small) => {
      onReady(small);
      return load(`${base}textures/earth-4096.jpg`);
    })
    .then(onReady)
    .catch(() => {
      /* the vector base map remains; nothing to tell the player */
    });
}
