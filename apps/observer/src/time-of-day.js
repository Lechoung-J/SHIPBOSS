import * as THREE from 'three';

// Keyframes are local wall-clock hours. Hold the night palette through 04:48;
// midnight must not begin a four-hour interpolation into daylight.
const KEYS = [
  { hour: 0, label: '夜晚', sky: '#1d2630', ground: '#242b30', hemiSky: '#8fa2b8', hemiGround: '#292b2c', hemi: .35, sun: '#8ea9d0', sunIntensity: .08, fill: .2, exposure: .82, window: '#48566b', interior: 32, cloud: '#282f39', cloudOpacity: .24 },
  { hour: 4.8, label: '夜晚', sky: '#1d2630', ground: '#242b30', hemiSky: '#8fa2b8', hemiGround: '#292b2c', hemi: .35, sun: '#8ea9d0', sunIntensity: .08, fill: .2, exposure: .82, window: '#48566b', interior: 32, cloud: '#282f39', cloudOpacity: .24 },
  { hour: 6.5, label: '清晨', sky: '#c9b7a7', ground: '#9b8878', hemiSky: '#f4dcc7', hemiGround: '#6e655c', hemi: 1.0, sun: '#ffd1a1', sunIntensity: 1.6, fill: .6, exposure: 1.0, window: '#ffd8ba', interior: 6, cloud: '#d9b7c4', cloudOpacity: .45 },
  { hour: 7.5, label: '白天', sky: '#c7c2b6', ground: '#a39e90', hemiSky: '#eeeae2', hemiGround: '#827d73', hemi: 1.3, sun: '#fff4df', sunIntensity: 2.8, fill: .85, exposure: 1.06, window: '#ffffff', interior: 0, cloud: '#f0ece2', cloudOpacity: .62 },
  { hour: 16.5, label: '白天', sky: '#c7c2b6', ground: '#a39e90', hemiSky: '#eeeae2', hemiGround: '#827d73', hemi: 1.3, sun: '#fff4df', sunIntensity: 2.8, fill: .85, exposure: 1.06, window: '#ffffff', interior: 0, cloud: '#f0ece2', cloudOpacity: .62 },
  { hour: 18.2, label: '黄昏', sky: '#b05f8c', ground: '#3a2a43', hemiSky: '#d48bb5', hemiGround: '#3a2c40', hemi: .55, sun: '#ff96b4', sunIntensity: 1.05, fill: .25, exposure: .92, window: '#ff9fc8', interior: 10, cloud: '#6a5676', cloudOpacity: .46 },
  { hour: 19.4, label: '黄昏', sky: '#5b3668', ground: '#2d2438', hemiSky: '#a36bac', hemiGround: '#292233', hemi: .38, sun: '#a35ab4', sunIntensity: .4, fill: .18, exposure: .86, window: '#b674b6', interior: 18, cloud: '#51435b', cloudOpacity: .36 },
  { hour: 20.5, label: '夜晚', sky: '#1d2630', ground: '#242b30', hemiSky: '#8fa2b8', hemiGround: '#292b2c', hemi: .35, sun: '#8ea9d0', sunIntensity: .08, fill: .2, exposure: .82, window: '#48566b', interior: 32, cloud: '#282f39', cloudOpacity: .24 },
  { hour: 24, label: '夜晚', sky: '#1d2630', ground: '#242b30', hemiSky: '#8fa2b8', hemiGround: '#292b2c', hemi: .35, sun: '#8ea9d0', sunIntensity: .08, fill: .2, exposure: .82, window: '#48566b', interior: 32, cloud: '#282f39', cloudOpacity: .24 },
];

const color = hex => new THREE.Color(hex);
const smooth = value => value * value * (3 - 2 * value);
const mixNumber = (a, b, t) => a + (b - a) * t;
const mixColor = (a, b, t) => color(a).lerp(color(b), t);

// Continuous palette sampled at minute resolution. No abrupt phase switch.
export function sampleTimeOfDay(date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  let index = 0;
  while (index < KEYS.length - 2 && hour >= KEYS[index + 1].hour) index++;
  const from = KEYS[index], to = KEYS[index + 1];
  const t = smooth(THREE.MathUtils.clamp((hour - from.hour) / (to.hour - from.hour), 0, 1));
  const label = hour < 5 ? '夜晚' : hour < 7.5 ? '清晨' : hour < 17 ? '白天' : hour < 20 ? '黄昏' : '夜晚';
  return {
    hour,
    label,
    sky: mixColor(from.sky, to.sky, t),
    ground: mixColor(from.ground, to.ground, t),
    hemiSky: mixColor(from.hemiSky, to.hemiSky, t),
    hemiGround: mixColor(from.hemiGround, to.hemiGround, t),
    sun: mixColor(from.sun, to.sun, t),
    windowTint: mixColor(from.window, to.window, t),
    cloud: mixColor(from.cloud, to.cloud, t),
    cloudOpacity: mixNumber(from.cloudOpacity, to.cloudOpacity, t),
    hemiIntensity: mixNumber(from.hemi, to.hemi, t),
    sunIntensity: mixNumber(from.sunIntensity, to.sunIntensity, t),
    fillIntensity: mixNumber(from.fill, to.fill, t),
    exposure: mixNumber(from.exposure, to.exposure, t),
    interiorIntensity: mixNumber(from.interior, to.interior, t),
  };
}

// A low sun at dawn and dusk gives longer, warmer shadows.
export function sunPosition(hour) {
  const day = THREE.MathUtils.clamp((hour - 5.5) / 13, 0, 1);
  const elevation = Math.sin(day * Math.PI);
  const azimuth = -.55 + day * 1.1;
  return {
    x: 5 + Math.cos(azimuth) * 27,
    y: 5 + elevation * 33,
    z: 15 + Math.sin(azimuth) * 14,
  };
}
