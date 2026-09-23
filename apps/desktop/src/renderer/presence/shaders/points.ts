import { NOISE } from './noise.js';

/**
 * The point field: where the whole presence is drawn.
 *
 * Two things here are load-bearing and easy to lose in a rewrite. The geometry
 * holds only unit directions — every displacement happens in this shader, which
 * is why a state change costs nothing and the buffers are never rebuilt. And
 * the normal is reconstructed per point by sampling the displacement at two
 * tangent offsets and crossing the differences: that gradient is what makes
 * fifteen thousand dots read as one lit, volumetric surface instead of a
 * scatter of sprites.
 */
export const POINTS_VERT = `
precision highp float;
attribute vec3 aDir;
attribute float aRand;
attribute float aRow;
uniform float uTime, uAmp, uFreq, uTorsion, uJitter, uPulse, uSize, uRim,
              uBright, uLevel, uPix, uHeight, uLineBias, uIrid, uWarm;
varying float vShade;
varying float vFres;
varying float vHue;
${NOISE}

float disp(vec3 p){
  float n  = snoise(p * uFreq + vec3(0.0, 0.0, uTime * 0.35));
  float n2 = snoise(p * uFreq * 2.15 + vec3(uTime * 0.22, 0.0, 0.0)) * 0.45;
  float th = atan(p.z, p.x);
  float ph = acos(clamp(p.y, -1.0, 1.0));
  float lobes = sin(th * 5.0 + uTime * 0.4) * 0.30 + sin(ph * 4.0 - uTime * 0.25) * 0.22;
  float twist = sin(th * 3.0 + p.y * 4.5 + uTime * 0.65) * uTorsion;
  return (n + n2) * uAmp + lobes * uAmp * 0.65 + twist + uPulse * uLevel;
}

void main(){
  vec3 dir = normalize(aDir);
  // Two tangents, so the displaced surface can be shaded from its own gradient.
  vec3 t1 = normalize(abs(dir.y) < 0.98 ? cross(dir, vec3(0.0,1.0,0.0)) : vec3(1.0,0.0,0.0));
  vec3 t2 = cross(dir, t1);
  float e = 0.045;
  float d0 = disp(dir);
  float d1 = disp(normalize(dir + t1 * e));
  float d2 = disp(normalize(dir + t2 * e));

  float jit = (aRand - 0.5) * 0.06 * uJitter;
  float r = 1.0 + d0 + jit;
  vec3 pos = dir * r;

  vec3 p1 = normalize(dir + t1 * e) * (1.0 + d1);
  vec3 p2 = normalize(dir + t2 * e) * (1.0 + d2);
  vec3 nrm = normalize(cross(p1 - pos, p2 - pos));
  if (dot(nrm, dir) < 0.0) nrm = -nrm;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec3 viewDir = normalize(-mv.xyz);
  vec3 nView = normalize(normalMatrix * nrm);

  vec3 key = normalize(vec3(-0.45, 0.85, 0.65));
  vec3 fill = normalize(vec3(0.7, -0.35, 0.4));
  float lam = max(dot(nView, key), 0.0);
  float spec = pow(max(dot(reflect(-key, nView), viewDir), 0.0), 26.0);
  float back = max(dot(nView, fill), 0.0) * 0.35;
  float fres = pow(1.0 - max(dot(nView, viewDir), 0.0), 2.4);

  vShade = (lam * 0.55 + spec * 1.6 + back) * uBright;
  vFres = fres * uRim;
  vHue = fract(fres * 0.6 + d0 * 1.4 + uTime * 0.02) * uIrid;

  // Rows read as lines; the bias keeps that ribbing legible.
  float rowFade = mix(1.0, 0.55 + 0.45 * sin(aRow * 3.1416 * 2.0), 1.0 - uLineBias);

  gl_Position = projectionMatrix * mv;
  // Point size follows canvas height and depth, so the cloud looks equally
  // dense at 26px and at 420px rather than thinning out as it grows.
  float sz = uSize * uPix * (uHeight / 760.0) * (2.9 / max(0.35, -mv.z));
  gl_PointSize = max(0.6, sz * (0.75 + 0.5 * aRand) * rowFade);
}`;

export const POINTS_FRAG = `
precision highp float;
uniform vec3 uColorA, uColorB, uWarmColor;
uniform float uOpacity, uGain, uWarm, uOnLight;
varying float vShade;
varying float vFres;
varying float vHue;

vec3 hueShift(vec3 c, float h){
  vec3 k = vec3(0.57735);
  float cosA = cos(h * 6.2831);
  return c * cosA + cross(k, c) * sin(h * 6.2831) + k * dot(k, c) * (1.0 - cosA);
}

void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = dot(uv, uv);
  if (d > 0.25) discard;
  float mask = smoothstep(0.25, 0.04, d);

  float s = clamp(vShade + vFres * 0.7, 0.0, 3.0);
  vec3 col = mix(uColorB, uColorA, clamp(s, 0.0, 1.0));
  col += uColorA * max(s - 1.0, 0.0) * 0.6;
  if (vHue > 0.001) col = hueShift(col, vHue * 0.25);
  col = mix(col, uWarmColor, uWarm * clamp(vFres * 1.2, 0.0, 1.0) * 0.75);

  /*
   * How much of each point actually lands, which is not the same question in
   * the two appearances.
   *
   * Added to a dark surface, a point is only visible to the extent it is lit,
   * so the alpha follows the shading: the unlit side contributes almost
   * nothing and the object is its own highlight. Laid on paper it is the
   * other way round — the unlit side is the part that shows, and an alpha
   * that fades with shade leaves a ghost where the body should be. So on
   * light the ink is nearly even and the tone is carried by the colour, which
   * is how a drawn object on a page works.
   */
  float a = uOpacity * mask * (uOnLight > 0.5
    ? clamp(0.55 + s * 0.25, 0.0, 1.0)
    : clamp(0.16 + s * 0.9, 0.0, 1.0));
  gl_FragColor = vec4(col * uGain, a);
}`;
