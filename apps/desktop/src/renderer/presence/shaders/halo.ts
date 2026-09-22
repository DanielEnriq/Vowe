/**
 * The ring around the presence, drawn on a quad that is never itself visible.
 *
 * Everything outside the ring is discarded rather than faded. An additive fill
 * would lighten the whole quad and read as a square panel behind Vowe, which is
 * exactly the kind of artefact that makes a transparent canvas look pasted on.
 */
export const HALO_VERT = `
precision highp float;
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const HALO_FRAG = `
precision highp float;
uniform float uHalo, uTime, uLevel;
uniform vec3 uColorA;
varying vec2 vUv;
void main(){
  float r = length(vUv - 0.5) * 2.0;
  if (r > 0.98) discard;
  float target = 0.80 + 0.04 * sin(uTime * 1.6) + uLevel * 0.05;
  float ring = smoothstep(0.035, 0.0, abs(r - target));
  float a = ring * 0.5 * uHalo;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColorA, a);
}`;
