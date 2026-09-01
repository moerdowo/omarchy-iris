// The iris character: a glass orb with a band of light running through it.
//
// Ported from the SiriOrb component on maia.id, which is a four-pass WebGL2
// pipeline — a wave shader rendered to a texture, composited into a rounded
// glass panel with refraction and a rim highlight. What is carried over is the
// CONSTRUCTION, not the technique: four copies of one sine wave, phase-spread
// across an RGB spectrum so they separate into colour at the crests, summed
// additively, tapered to nothing at the flanks, and read through a glass ball
// that is dark at the crown and pale at the floor.
//
// Three things in the original that read as arbitrary and are not:
//
//   - the four layers are spread in PHASE, not in hue offset. Chromatic
//     aberration is what makes the band look refracted rather than painted;
//     spreading hue alone gives a flat rainbow stripe.
//   - the envelope is cos squared, not a window or a gaussian. It reaches zero
//     with zero slope, so the band dies at the orb's flanks instead of being
//     cut off by the clip.
//   - the sum is raised to 1.5 before clipping. That is what turns overlapping
//     crests white while the tails stay saturated, and it is the whole of the
//     "lit from inside" read.
//
// What changed in the port is the output: the original accumulates per-pixel in
// a fragment shader, this strokes polylines additively onto QML's Canvas. At a
// companion's size the difference is a softer core and a faked refraction —
// gradients rather than real sampling — which is the price of shipping no
// compiled shader and no build step.
//
// Everything with a number in it lives here. IrisBody.qml is the part a canvas
// needs and a pure engine must not have: a clock, the desktop's palette, and
// the translation from the plugin's moods to this character's states.

.pragma library

/* ------------------------------------------------------- the drawing frame */

/**
 * The orb's radius, in view-box units. Chosen, not measured: it is the working
 * unit, and everything else in this file is a fraction of it, which is what
 * makes the geometry independent of display size.
 */
var RAYON = 100

/**
 * Half the view box. The margin past the radius is where the halo lives — the
 * glow that leaks out of the glass, and the swell performance, which is the one
 * that pushes furthest past the rim.
 */
var DEMI_VIEWBOX = 128

/**
 * How far the drawing reaches past the orb on each side, as a fraction of its
 * diameter. The canvas is inflated by this and the ground line lowered by it,
 * so the halo is not sliced off by the bottom of the screen.
 */
var OVERFLOW = (DEMI_VIEWBOX - RAYON) / (RAYON * 2)

/** How many points the band is sampled at across the orb. */
var BAND_STEPS = 48

/**
 * The four layers, and the spectrum they are read through.
 *
 * `spectrumTri` in the original is a triangle sweep over 0..5 that yields red,
 * green, blue and white at the four layer indices. Those are the values it
 * produces, written out: computing them at 30 fps to arrive at four constants
 * is work the port does not have to do.
 */
var LAYERS = [
  { rgb: [1.00, 0.34, 0.38], spread: -1 },
  { rgb: [0.46, 1.00, 0.62], spread: -0.3333 },
  { rgb: [0.48, 0.58, 1.00], spread: 0.3333 },
  { rgb: [1.00, 0.98, 0.94], spread: 1 }
]

/* ------------------------------------------------------------------- math */

/**
 * Reads an id out of one of the catalogues below.
 *
 * Every one of those ids arrives from shell.json or a command line, so a plain
 * `map[value]` is not a lookup: `constructor` and `prototype` are inherited
 * from Object and answer truthy, which would have `isShellId("constructor")`
 * say yes and the engine then ask a function for its rim width.
 */
function lookup(map, value) {
  var key = String(value === undefined || value === null ? "" : value)
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
}

var TAU = Math.PI * 2

function clamp(v, lo, hi) {
  if (lo === undefined) lo = 0
  if (hi === undefined) hi = 1
  return v < lo ? lo : (v > hi ? hi : v)
}

function lerp(a, b, t) { return a + (b - a) * t }

var easings = {
  easeOutCubic: function(t) { return 1 - Math.pow(1 - t, 3) },
  easeInOutCubic: function(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  },
  easeOutQuint: function(t) { return 1 - Math.pow(1 - t, 5) }
}

/**
 * A drift that repeats exactly, built from two sines whose periods divide the
 * loop. A random walk would serve as well until the orb is asked to hold still
 * for a screenshot, at which point "exactly" is the whole requirement.
 */
function loopNoise(t, period, seed) {
  var p = t / period * TAU
  return 0.6 * Math.sin(p + seed) + 0.4 * Math.sin(2 * p + seed * 1.7)
}

/* ---------------------------------------------------------------- the wave */

/**
 * The band's parameters. Every state below is a departure from this, and the
 * cross-fade between two states is a straight interpolation of these numbers —
 * which is the reason the character has no cuts anywhere in it.
 *
 * The values are the original's uniform defaults, converted from its normalised
 * space to this one: amplitude and thickness as fractions of RAYON, frequency
 * in cycles across the diameter, speed in radians per second.
 */
var WAVE = {
  /** Peak swing of the band, as a fraction of the radius. */
  amplitude: 0.26,
  // Cycles of the sine across the orb's width. Under one on purpose: the
  // original shows a single broad crest, and at a full cycle the band reads as
  // a waveform display rather than as light moving through glass.
  freq: 0.85,
  /** Radians per second the phase advances. Negative runs it leftward, as in
   *  the original — a band that travels right reads as a progress bar. */
  speed: -1.0,
  /** How far apart the four layers are pushed in phase. This is the colour. */
  aberration: 1.3,
  /** Core half-width of the stroke, as a fraction of the radius. */
  thickness: 0.05,
  /** Brightness of the glow. */
  intensity: 0.9,
  // How hard the band is squeezed towards the centre horizontally. The
  // original's 1.7 is over a view box 1.11 radii wide; here the band spans the
  // ball itself, and carrying the number across unchanged strangles it into a
  // spindle at the middle. 1.15 is that same curve measured over this width.
  falloff: 1.15,
  /** Where the band sits vertically; 0 is the equator, negative is up. */
  lift: 0,
  /** 0 draws the band white, 1 draws it through the full spectrum. */
  spectrum: 1,
  // How far the whole band collapses towards the alarm red. This is the one
  // place the character's own palette is overruled, and it is deliberate: a
  // person who has dressed their companion in Ice still needs an error to look
  // like an error, and the shape alone does not carry that across a room.
  hot: 0,
  /** Fill brightness between the outermost pair of layers. */
  bandFill: 0.55,
  /** Rotation of the whole band, in degrees. */
  tilt: 0,
  /** Overall opacity, for states that fade rather than flatten. */
  alpha: 1
}

function waveDefaults(over) {
  var w = {}
  for (var k in WAVE) if (WAVE.hasOwnProperty(k)) w[k] = WAVE[k]
  if (over) for (var j in over) if (over.hasOwnProperty(j)) w[j] = over[j]
  return w
}

function lerpWave(a, b, t) {
  var out = {}
  for (var k in WAVE) if (WAVE.hasOwnProperty(k)) out[k] = lerp(a[k], b[k], t)
  return out
}

/**
 * The band's height at one point across the orb, for one layer.
 *
 * `x` is in radius units, -1 at the left flank and 1 at the right. The two
 * envelopes are both from the original and do different jobs: `cw2` is the
 * cosine-squared taper that lands the band on zero at the flanks, and `fall` is
 * a gaussian that pulls its energy towards the middle. Together they are why
 * the band reads as suspended in the ball rather than drawn across it.
 */
function bandAt(w, x, phase, spread) {
  var cw = Math.min(Math.abs(x * 0.9), 1)
  var cw2 = Math.pow(Math.cos(cw * Math.PI / 2), 2)
  var fall = Math.exp(-Math.pow(x * w.falloff, 2))
  var ph = x * w.freq * Math.PI + phase + spread * w.aberration
  return w.lift + cw2 * fall * w.amplitude * Math.sin(ph)
}

/* ------------------------------------------------------------------ shells */

// The glass the band is read through. `bare` is not a missing shell: an orb
// with no glass is the wave in open air, which is a legitimate look and the one
// that stays legible smallest.
var SHELLS = [
  { id: "glass", name: "Glass", crown: 0.62, floor: 0.5, rim: 0.9, spec: 0.85, refract: 1 },
  { id: "clear", name: "Clear", crown: 0.22, floor: 0.18, rim: 0.55, spec: 0.4, refract: 0.5 },
  { id: "frosted", name: "Frosted", crown: 0.4, floor: 0.72, rim: 0.35, spec: 0.2, refract: 0.3 },
  { id: "halo", name: "Halo", crown: 0.8, floor: 0.66, rim: 1, spec: 0.5, refract: 0.8 },
  { id: "bare", name: "Bare", crown: 0, floor: 0, rim: 0, spec: 0, refract: 0 }
]

var SHELL_BY_ID = {}
for (var _sh = 0; _sh < SHELLS.length; _sh++) SHELL_BY_ID[SHELLS[_sh].id] = SHELLS[_sh]
var DEFAULT_SHELL = "glass"

/* ------------------------------------------------------------------- tints */

// What the four layers are painted with. `spectrum` is the original's own
// palette and the default; the rest narrow it, which is what makes a desktop
// that does not want a rainbow on it still able to keep the character.
//
// `theme` is the one entry with no colours of its own: it wears the current
// accent, spread into four layers by the renderer, because only the renderer
// knows what the accent is.
var TINTS = [
  { id: "spectrum", name: "Spectrum", rgb: null },
  { id: "theme", name: "Theme accent", rgb: null, accent: true },
  { id: "ice", name: "Ice", rgb: [[0.35, 0.75, 1.0], [0.5, 0.9, 1.0], [0.7, 0.85, 1.0], [1, 1, 1]] },
  { id: "ember", name: "Ember", rgb: [[1.0, 0.28, 0.12], [1.0, 0.52, 0.15], [1.0, 0.76, 0.3], [1, 0.95, 0.85]] },
  { id: "aurora", name: "Aurora", rgb: [[0.2, 1.0, 0.65], [0.3, 0.85, 1.0], [0.55, 0.5, 1.0], [0.9, 1, 1]] },
  { id: "bloom", name: "Bloom", rgb: [[1.0, 0.35, 0.7], [0.85, 0.4, 1.0], [0.55, 0.55, 1.0], [1, 0.9, 1]] },
  { id: "mono", name: "Mono", rgb: [[1, 1, 1], [0.85, 0.87, 0.9], [0.7, 0.74, 0.8], [1, 1, 1]] }
]

var TINT_BY_ID = {}
for (var _ti = 0; _ti < TINTS.length; _ti++) TINT_BY_ID[TINTS[_ti].id] = TINTS[_ti]
var DEFAULT_TINT = "spectrum"

/**
 * Parses `#rrggbb` — or `#aarrggbb`, which is what a QML colour prints once it
 * has an alpha — into 0..1 components. Takes the LAST six digits, because
 * reading `ff1a1b26` from the front gives `ff1a1b`, a different colour that
 * looks plausible enough not to be noticed.
 */
function parseHex(h) {
  var hex = String(h).replace("#", "")
  var v = parseInt(hex.slice(Math.max(0, hex.length - 6)), 16)
  if (!isFinite(v)) v = 0
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/**
 * The four layer colours, resolved.
 *
 * `theme` has no palette of its own, so one is built from the accent: the
 * accent itself, two neighbours pulled either side of it, and white. Spreading
 * a single hue this way keeps the aberration visible — four layers of one exact
 * colour would sum to a grey-white band and lose the refraction that is the
 * point of having four.
 */
function paletteFor(id, accent) {
  var t = lookup(TINT_BY_ID, tintId(id))
  if (t && t.rgb) return t.rgb
  if (t && t.accent) {
    var a = parseHex(accent)
    return [
      [clamp(a[0] * 1.15), clamp(a[1] * 0.72), clamp(a[2] * 0.9)],
      [clamp(a[0]), clamp(a[1]), clamp(a[2])],
      [clamp(a[0] * 0.72), clamp(a[1] * 0.95), clamp(a[2] * 1.2)],
      [1, 1, 1]
    ]
  }
  var out = []
  for (var i = 0; i < LAYERS.length; i++) out.push(LAYERS[i].rgb)
  return out
}

/* ----------------------------------------------------------------- tempers */

// The resting character of the band: what it does when nothing is happening.
//
// This is the slot the drawn creature this plugin used to wear spent on facial
// expressions. An orb has no face, so the same idea is carried by how the light
// behaves — and it has to be carried by something, because "the companion is
// resting" and "the companion is resting AND pleased" are two different things
// the desktop still needs to be able to say.
var TEMPERS = [
  { id: "calm", name: "Calm", wave: {} },
  { id: "attentive", name: "Attentive",
    wave: { amplitude: 0.28, freq: 1.35, speed: -1.35, thickness: 0.042, intensity: 1.05 } },
  { id: "lively", name: "Lively",
    wave: { amplitude: 0.34, freq: 1.7, speed: -2.1, aberration: 1.6, intensity: 1.1 } },
  { id: "dreaming", name: "Dreaming",
    wave: { amplitude: 0.16, freq: 0.7, speed: -0.55, thickness: 0.075, intensity: 0.72, bandFill: 0.8 } },
  { id: "deep", name: "Deep",
    wave: { amplitude: 0.2, freq: 0.85, speed: -0.7, aberration: 1.8, lift: 0.06, intensity: 0.85 } },
  { id: "shy", name: "Shy",
    wave: { amplitude: 0.13, freq: 1.0, speed: -0.8, falloff: 2.4, intensity: 0.7, spectrum: 0.6 } },
  { id: "proud", name: "Proud",
    wave: { amplitude: 0.26, freq: 0.9, speed: -0.9, lift: -0.1, intensity: 1.15, bandFill: 0.7 } },
  { id: "restless", name: "Restless",
    wave: { amplitude: 0.3, freq: 2.2, speed: -2.6, thickness: 0.036, aberration: 1.0 } }
]

var TEMPER_BY_ID = {}
for (var _te = 0; _te < TEMPERS.length; _te++) TEMPER_BY_ID[TEMPERS[_te].id] = TEMPERS[_te]
var DEFAULT_TEMPER = "calm"

function temperWave(id) {
  var t = lookup(TEMPER_BY_ID, id)
  return waveDefaults(t ? t.wave : null)
}

/* ------------------------------------------------------------------ states */

// What the orb is doing. A state is a function of local time returning a wave,
// plus the two numbers the cross-fade needs: how long one run lasts, and how
// long the fade into it takes.
//
// `duration` is what the engine loops a resting state on; `minDuration` holds a
// state that has something to finish before it may be interrupted.
var STATES = [
  { id: "idle", duration: 6, morph: 0.5,
    pose: function(t, base) {
      // Everything a resting orb does. The drift is small on purpose: the band
      // already travels, so a resting state that also swings would read as
      // agitated rather than alive.
      return waveDefaults({
        amplitude: base.amplitude * (1 + 0.1 * loopNoise(t, 6, 0.4)),
        freq: base.freq,
        speed: base.speed,
        aberration: base.aberration * (1 + 0.07 * loopNoise(t, 6, 2.1)),
        thickness: base.thickness,
        intensity: base.intensity * (1 + 0.05 * loopNoise(t, 6, 3.7)),
        falloff: base.falloff,
        lift: base.lift + 0.02 * loopNoise(t, 6, 1.3),
        spectrum: base.spectrum,
        bandFill: base.bandFill,
        tilt: 1.5 * loopNoise(t, 6, 0.9)
      })
    } },

  // A turn being worked on. Fast and wide: the aberration opens up so the four
  // layers separate into visible colour, which is the one change that reads
  // instantly as "something is happening" without borrowing a progress bar.
  { id: "thinking", duration: 2.2, morph: 0.35,
    pose: function(t) {
      var pulse = 0.5 + 0.5 * Math.sin(t / 2.2 * TAU)
      return waveDefaults({
        amplitude: 0.3 + 0.08 * pulse,
        freq: 1.9, speed: -3.4,
        aberration: 2.4 + 0.9 * pulse,
        thickness: 0.04,
        intensity: 1.15,
        bandFill: 0.75
      })
    } },

  // Waiting on the person. The band holds still and BREATHES instead of
  // running: stopping the travel is what separates "I am working" from "I have
  // stopped and it is your turn", and it costs no new vocabulary to read.
  { id: "notify", duration: 2.6, morph: 0.4,
    pose: function(t) {
      var breath = 0.5 + 0.5 * Math.sin(t / 2.6 * TAU)
      return waveDefaults({
        amplitude: 0.15 + 0.12 * breath,
        freq: 0.8, speed: -0.35,
        aberration: 1.15,
        thickness: 0.052 + 0.018 * breath,
        intensity: 0.85 + 0.35 * breath,
        bandFill: 0.85
      })
    } },

  // Success. One surge that blooms past the rim and settles back, rather than a
  // flash: a flash and an error flash are the same event at a glance.
  { id: "burst", duration: 2.4, minDuration: 1.6, morph: 0.3,
    pose: function(t) {
      var rise = easings.easeOutQuint(clamp(t / 0.35))
      var fall = easings.easeOutCubic(clamp((t - 0.35) / 1.6))
      var e = rise * (1 - fall * 0.78)
      return waveDefaults({
        amplitude: 0.22 + 0.55 * e,
        freq: 1.0 + 0.5 * e,
        speed: -1.6 - 2.2 * e,
        aberration: 1.3 + 2.0 * e,
        thickness: 0.05 + 0.04 * e,
        intensity: 0.9 + 1.5 * e,
        falloff: 1.7 - 0.5 * e,
        bandFill: 0.55 + 0.4 * e
      })
    } },

  // Something went wrong. Hot, tight, and low in the ball: the spectrum
  // collapses towards its red end and the band stops travelling and shudders,
  // which is a different motion from every other state rather than a louder
  // version of one.
  { id: "alert", duration: 2.4, minDuration: 2, morph: 0.35,
    pose: function(t) {
      var shudder = Math.sin(t * 9 * TAU) * Math.exp(-t * 0.7)
      var settle = easings.easeOutCubic(clamp(t / 1.2))
      return waveDefaults({
        amplitude: 0.34 - 0.1 * settle + 0.05 * shudder,
        freq: 2.6, speed: -0.6,
        aberration: 0.55,
        thickness: 0.034,
        intensity: 1.35 - 0.25 * settle,
        falloff: 2.6,
        lift: 0.03,
        spectrum: 0.9,
        hot: 0.88,
        bandFill: 0.9,
        tilt: 3 * shudder
      })
    } },

  // Asleep. Not off — a flat, dim, very slow line that still moves, because an
  // orb that stops entirely is indistinguishable from one that has crashed.
  { id: "sleep", duration: 9, morph: 0.9,
    pose: function(t) {
      return waveDefaults({
        amplitude: 0.05 + 0.015 * Math.sin(t / 4.5 * TAU),
        freq: 0.5, speed: -0.25,
        aberration: 0.7,
        thickness: 0.07,
        intensity: 0.34,
        falloff: 1.2,
        lift: 0.1,
        spectrum: 0.4,
        bandFill: 0.4,
        alpha: 0.8
      })
    } },

  // Being carried. The band lags behind the hand and sloshes like something
  // with weight in it, then settles — the one state the person is causing
  // directly, so it has to answer immediately.
  { id: "carried", duration: 3, morph: 0.22,
    pose: function(t) {
      var slosh = Math.sin(t * 1.6 * TAU) * Math.exp(-t * 0.5)
      return waveDefaults({
        amplitude: 0.3 + 0.12 * slosh,
        freq: 0.75, speed: -0.5,
        aberration: 1.7,
        thickness: 0.05,
        intensity: 1.05,
        lift: 0.06 * slosh,
        tilt: 9 * slosh,
        bandFill: 0.7
      })
    } },

  /* ---------------------------------------------------- performance states */

  // The spectrum walks through the band from one flank to the other.
  { id: "shimmer", duration: 2.6, minDuration: 2.2, morph: 0.4,
    pose: function(t) {
      var sweep = clamp(t / 2.2)
      return waveDefaults({
        amplitude: 0.24,
        freq: 1.2, speed: -1.2,
        aberration: 1.3 + 1.9 * Math.sin(sweep * Math.PI),
        thickness: 0.045,
        intensity: 1.0 + 0.3 * Math.sin(sweep * Math.PI),
        bandFill: 0.65
      })
    } },

  // The band blooms out to the rim and eases back. The orb's stretch.
  { id: "swell", duration: 2.2, minDuration: 1.8, morph: 0.45,
    pose: function(t) {
      var e = Math.sin(clamp(t / 1.8) * Math.PI)
      return waveDefaults({
        amplitude: 0.22 + 0.5 * e,
        freq: 0.9 - 0.25 * e,
        speed: -1.0,
        aberration: 1.3 + 1.0 * e,
        thickness: 0.05 + 0.03 * e,
        intensity: 0.9 + 0.5 * e,
        falloff: 1.7 - 0.6 * e,
        bandFill: 0.55 + 0.3 * e
      })
    } },

  // A second harmonic crosses the first and passes through it.
  { id: "ripple", duration: 2.4, minDuration: 2, morph: 0.4,
    pose: function(t) {
      var e = Math.sin(clamp(t / 2) * Math.PI)
      return waveDefaults({
        amplitude: 0.2 + 0.06 * e,
        freq: 1.1 + 2.6 * e,
        speed: -1.0 - 1.6 * e,
        aberration: 1.3,
        thickness: 0.042,
        intensity: 0.95,
        bandFill: 0.5
      })
    } },

  // The whole band rotates through the ball and comes back level. It must END
  // level: a performance that leaves the orb tilted has changed the character
  // rather than performed.
  { id: "spin", duration: 3.4, minDuration: 3.2, morph: 0.4,
    pose: function(t) {
      var p = easings.easeInOutCubic(clamp(t / 3.2))
      return waveDefaults({
        amplitude: 0.24,
        freq: 1.0, speed: -1.1,
        aberration: 1.5,
        thickness: 0.045,
        intensity: 1.0,
        tilt: 360 * p,
        bandFill: 0.6
      })
    } },

  // The band collapses to a point at the centre and grows back out of it.
  { id: "collapse", duration: 2.6, minDuration: 2.4, morph: 0.4,
    pose: function(t) {
      var inward = easings.easeOutQuint(clamp(t / 0.6))
      var back = easings.easeOutQuint(clamp((t - 1.5) / 0.9))
      var k = 1 - inward + back * inward
      return waveDefaults({
        amplitude: 0.22 * k,
        freq: 1.1,
        speed: -1.0 - 3 * (1 - k),
        aberration: 1.3 + 2.4 * (1 - k),
        thickness: 0.05 + 0.07 * (1 - k),
        intensity: 0.9 + 1.1 * (1 - k),
        falloff: 1.7 + 2.5 * (1 - k),
        bandFill: 0.55
      })
    } }
]

var STATE_BY_ID = {}
for (var _st = 0; _st < STATES.length; _st++) STATE_BY_ID[STATES[_st].id] = STATES[_st]

/**
 * The moment, in local time, where each state reads best: the frame the frozen
 * previews show, and what a desktop that has asked for reduced motion holds.
 */
var POSES = {
  idle: 1.2, thinking: 1.1, notify: 1.3, burst: 0.5, alert: 0.6, sleep: 2,
  carried: 0.4, shimmer: 1.1, swell: 0.9, ripple: 1, spin: 1.6, collapse: 0.5
}

/** When to freeze a state for a desktop that has asked for reduced motion. */
function restingMoment(state) {
  var t = lookup(POSES, state)
  return t === null ? 1 : t
}

/* ------------------------------------------------------------------- looks */

// A drawn creature with eyes points them at things. An orb has none, so the
// same intent — the companion is attending to you, or to what it is doing — is
// carried by leaning the band: `yaw` slides its energy left or right, `pitch`
// raises or lowers it in the ball. That keeps every gaze script the plugin
// already has, including the pointer tracking, without a face to hang it on.

var YAW_MAX = 0.34
var PITCH_MAX = 0.22
var LOOK_MORPH = 0.32

// `pitch` is positive UP, against the screen's own y. Every look below is
// written in those terms and `sample` does the one subtraction that converts
// them, so a script never has to remember which way the canvas counts.
var NO_LOOK = { yaw: 0, pitch: 0, mix: 0, wander: 1 }

function lerpLook(a, b, t) {
  return {
    yaw: lerp(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    mix: lerp(a.mix, b.mix, t),
    wander: lerp(a.wander, b.wander, t)
  }
}

/**
 * Leaning towards a point. `nx` and `ny` are offsets from the orb's centre,
 * each -1 to 1.
 */
function lookAt(nx, ny, mix) {
  return {
    yaw: clamp(nx, -1, 1) * YAW_MAX,
    // positive pitch means the band rises, while the screen's y goes down
    pitch: -clamp(ny, -1, 1) * PITCH_MAX,
    mix: clamp(mix),
    // With a pointer the automatic drift stands down: added together, the orb
    // looks like it is hunting for the cursor without ever holding it.
    wander: 1 - clamp(mix)
  }
}

/**
 * Noticing whoever is at the desk: the band lifts, holds, and settles back.
 *
 * A gaze script — a pure function of the time since the performance began, in
 * seconds, evaluated every frame. The rule that keeps such a script free of
 * maintenance is that it must END at `mix: 0`, handing the band back to the
 * state with nothing left to release, or there is one last slide just as
 * everything should have settled.
 */
function noticeLook(t, seconds) {
  var total = seconds > 0 ? seconds : 3.4
  var rise = easings.easeOutCubic(clamp(t / 0.5))
  var hold = clamp((total - 0.7 - t) / 0.5)
  var mix = rise * hold
  return { yaw: 0.12 * Math.sin(t * 0.9), pitch: 0.9 * PITCH_MAX, mix: mix, wander: 1 - mix }
}

/**
 * Working something out: a slow sweep from side to side, never settling. This
 * is what tells a turn apart from resting, since the two share a state.
 */
function ponderLook(t) {
  return {
    yaw: 0.72 * YAW_MAX * Math.sin(t * 0.42),
    pitch: -0.3 * PITCH_MAX + 0.25 * PITCH_MAX * Math.sin(t * 0.27),
    mix: 0.85,
    wander: 0.15
  }
}

/* ------------------------------------------------------------------ engine */

/**
 * The character, as a pure function of time.
 *
 * Nothing outside this holds where an animation has got to: every setter is
 * DATED, and `sample(t)` returns the frame for that date and no other. Two
 * calls with the same date always draw the same picture, which is what lets the
 * body freeze itself for reduced motion by simply not advancing its clock.
 */
function createEngine(scale, initial, shellName, temperName) {
  var self = {}
  var R = scale === undefined ? 100 : scale

  var cur = initial || "idle"
  var prev = null
  // A FROZEN departure wave, set only when a state change lands while a
  // cross-fade is already running. See setState.
  var departFrozen = null
  var tCur = 0
  var tPrev = 0

  var shell = shellName || DEFAULT_SHELL
  var temper = temperName || DEFAULT_TEMPER
  var temperPrev = null
  var temperAt = -10

  var look = NO_LOOK
  var lookPrev = NO_LOOK
  var lookSetAt = -10
  var lookMorph = LOOK_MORPH

  /* ------------------------------------------------------------- setters */

  /**
   * The resting temper chosen in the customiser. Like everything else here it
   * slides to its new value instead of cutting.
   */
  self.setTemper = function(id, now) {
    if (id === temper) return
    temperPrev = temper
    temper = id
    temperAt = now || 0
  }

  /** The glass. It has no morph: it is a treatment, not a motion. */
  self.setShell = function(id) { shell = id || DEFAULT_SHELL }

  /** The resting wave at `now`, mid-morph between two tempers included. */
  function temperAtTime(now) {
    var to = temperWave(temper)
    if (temperPrev === null) return to
    var t = clamp((now - temperAt) / 0.55)
    if (t >= 1) { temperPrev = null; return to }
    return lerpWave(temperWave(temperPrev), to, easings.easeOutCubic(t))
  }

  /**
   * Starts a state at `now`.
   *
   * A change arriving mid-fade cannot simply push the running state into the
   * `prev` slot: that state is itself still a blend, and sampling it again a
   * frame later gives a different picture than the one on screen. The blend as
   * it stands is FROZEN instead, and the new state fades out of that — which is
   * the only way a run of quick changes stays continuous.
   */
  self.setState = function(id, now) {
    if (id === cur) return
    var t = now || 0
    var fading = prev !== null && (t - tCur) < morphOf(cur)
    departFrozen = fading ? waveAt(t) : null
    prev = cur
    tPrev = tCur
    cur = id
    tCur = t
  }

  /** Restarts a state, discarding any fade. Used when the clock is moved. */
  self.reset = function(id, now) {
    cur = id || cur
    prev = null
    departFrozen = null
    tCur = now || 0
    tPrev = tCur
  }

  /**
   * Hands the band a lean, or `null` to give it back to the state.
   *
   * `rate` is how fast it catches up; a script that is evaluated every frame
   * passes a small one so the band trails its target, which is what makes it
   * read as leaning rather than as being pinned.
   */
  self.setLook = function(next, now, rate) {
    var t = now || 0
    lookPrev = lookNow(t)
    lookSetAt = t
    lookMorph = rate === undefined ? LOOK_MORPH : Math.max(0.0001, rate)
    look = next || NO_LOOK
  }

  function lookNow(now) {
    var t = clamp((now - lookSetAt) / lookMorph)
    return lerpLook(lookPrev, look, easings.easeOutCubic(t))
  }

  /* -------------------------------------------------------------- sampling */

  function morphOf(id) {
    var s = lookup(STATE_BY_ID, id)
    return s && s.morph !== undefined ? s.morph : 0.4
  }

  function poseOf(id, local, base) {
    var s = lookup(STATE_BY_ID, id)
    if (!s) return waveDefaults()
    var d = s.duration || 1
    // Resting states loop; states with something to finish run once and hold
    // their last frame until something else is asked for.
    var t = s.minDuration ? Math.min(local, s.minDuration + 4) : (local % d)
    return s.pose(t, base)
  }

  /** The wave at `now`, cross-fade and all, before the lean is applied. */
  function waveAt(now) {
    var base = temperAtTime(now)
    var to = poseOf(cur, Math.max(0, now - tCur), base)
    if (prev === null) return to
    var t = (now - tCur) / morphOf(cur)
    if (t >= 1) { prev = null; departFrozen = null; return to }
    var from = departFrozen !== null
      ? departFrozen
      : poseOf(prev, Math.max(0, now - tPrev), base)
    return lerpWave(from, to, easings.easeOutCubic(clamp(t)))
  }

  /**
   * The frame for `now`: everything `paint` needs and nothing it has to work
   * out for itself.
   */
  self.sample = function(now) {
    var t = now || 0
    var w = waveAt(t)
    var l = lookNow(t)

    // The lean. Yaw does NOT slide the band sideways — a band that translates
    // reads as the whole orb moving. It biases the falloff instead, so the
    // band's energy gathers on the side being attended to, which is the same
    // information in a form the shape can carry.
    var yaw = l.yaw * l.mix
    var pitch = l.pitch * l.mix
    var wander = l.wander

    var phase = t * w.speed + 0.35 * wander * loopNoise(t, 11, 1.9)

    return {
      radius: R,
      wave: w,
      phase: phase,
      yaw: yaw,
      lift: w.lift - pitch,
      tilt: w.tilt + yaw * 14,
      shell: lookup(SHELL_BY_ID, shell) || SHELL_BY_ID[DEFAULT_SHELL],
      alpha: w.alpha
    }
  }

  return self
}

/* ------------------------------------------------------------------- moods */

var MOOD_STATE = {
  idle: "idle",
  parked: "idle",
  tired: "idle",
  love: "idle",
  // NOT the catalogue's `thinking` by accident: a turn genuinely gets its own
  // state here, unlike the drawn creature this replaced, which had to keep its
  // body and put the thought in its eyes. An orb has nowhere else to put it,
  // and a band that opens into colour is not a progress bar — it is the same
  // orb, working.
  working: "thinking",
  waiting: "notify",
  success: "burst",
  error: "alert",
  sleeping: "sleep",
  dragged: "carried"
}

/** Moods that speak through the resting temper instead of through a state. */
var MOOD_TEMPER = {
  tired: "dreaming",
  love: "proud",
  parked: "shy"
}

/**
 * The state a mood is shown as. Unknown moods rest, which is what every other
 * fallback in the plugin does.
 */
function stateForMood(mood) {
  var id = lookup(MOOD_STATE, mood)
  return id && lookup(STATE_BY_ID, id) ? id : "idle"
}

/**
 * The temper a mood imposes, or the chosen one if it imposes none. Only
 * consulted on states that wear the resting wave — asking on `burst` would
 * change nothing, since that state writes every number itself.
 */
function temperForMood(mood, chosen) {
  var id = lookup(MOOD_TEMPER, mood)
  if (id && lookup(TEMPER_BY_ID, id)) return id
  return temperId(chosen)
}

/**
 * Tempers a resting orb may borrow for a few seconds on its own.
 *
 * Only ones that carry no news, so the companion is never found looking alarmed
 * for nothing: `restless` is out of the pool for the same reason the creature
 * this replaced kept its frightened face out of it.
 */
var IDLE_TEMPERS = ["attentive", "lively", "dreaming", "deep", "proud", "shy"]

/**
 * One of the idle tempers, never the one already worn.
 *
 * `rand` is a FUNCTION returning 0..1, the same contract as Model.idleGlance, so
 * a caller passes `Math.random` rather than calling it. Using the argument as
 * though it were the number gives `NaN` for the index and `undefined` for the
 * temper, which QML then refuses to assign — silently costing every idle shift
 * rather than failing anywhere near the mistake.
 */
function idleTemper(rand, current) {
  var pool = []
  for (var i = 0; i < IDLE_TEMPERS.length; i++) {
    if (IDLE_TEMPERS[i] !== current) pool.push(IDLE_TEMPERS[i])
  }
  if (pool.length === 0) return current
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}

/* --------------------------------------------------- standby performances */

// What the orb does with itself while nothing is happening.
//
// Every one of them is NEUTRAL, and that is the selection rule rather than a
// matter of taste. The catalogue also holds `thinking`, `notify`, `alert` and
// `burst`, and those four are how the plugin says something is happening. An
// orb that performed them for its own amusement would be crying wolf, and the
// next real one would not be believed.
//
// `notice` is the one that is not just a state: it leans towards whoever is at
// the desk, which is a look rather than a wave. See `noticeLook`.
var PERFORMANCES = [
  { name: "notice", state: "idle", seconds: 3.4 },
  { name: "shimmer", state: "shimmer", seconds: 2.6 },
  { name: "swell", state: "swell", seconds: 2.2 },
  { name: "ripple", state: "ripple", seconds: 2.4 },
  { name: "spin", state: "spin", seconds: 3.4 },
  { name: "collapse", state: "collapse", seconds: 2.6 },
  // Long enough to read as asleep rather than as a dip. It is the one
  // performance whose whole point is that nothing happens for a while.
  { name: "doze", state: "sleep", seconds: 9 }
]

var PERFORMANCE_BY_NAME = {}
for (var _p = 0; _p < PERFORMANCES.length; _p++) {
  PERFORMANCE_BY_NAME[PERFORMANCES[_p].name] = PERFORMANCES[_p]
}

/**
 * The performances as activity tracks, which is what the rest of the plugin
 * already knows how to schedule.
 *
 * One frame held for the whole performance: `Model.activityDuration` multiplies
 * frames by holds, so a single hold of the full length is the honest way to say
 * "this lasts nine seconds" to code that was written for spritesheets. No `row`
 * is declared, because there is no sheet to have a row in.
 */
function performanceTracks() {
  var out = []
  for (var i = 0; i < PERFORMANCES.length; i++) {
    out.push({
      name: PERFORMANCES[i].name,
      frames: 1,
      holds: [Math.round(PERFORMANCES[i].seconds * 1000)]
    })
  }
  return out
}

function performanceState(name) {
  var p = lookup(PERFORMANCE_BY_NAME, name)
  return p && lookup(STATE_BY_ID, p.state) ? p.state : "idle"
}

function performanceSeconds(name) {
  var p = lookup(PERFORMANCE_BY_NAME, name)
  return p ? p.seconds : 0
}

/* -------------------------------------------------------------- catalogues */

function shellId(value) {
  var s = lookup(SHELL_BY_ID, value)
  return s ? s.id : DEFAULT_SHELL
}

function tintId(value) {
  var t = lookup(TINT_BY_ID, value)
  return t ? t.id : DEFAULT_TINT
}

function temperId(value) {
  var t = lookup(TEMPER_BY_ID, value)
  return t ? t.id : DEFAULT_TEMPER
}

function isShellId(value) { return lookup(SHELL_BY_ID, value) !== null }
function isTintId(value) { return lookup(TINT_BY_ID, value) !== null }
function isTemperId(value) { return lookup(TEMPER_BY_ID, value) !== null }

function panelOptions(list) {
  var out = []
  for (var i = 0; i < list.length; i++) out.push({ value: list[i].id, label: list[i].name })
  return out
}

/** The accepted values, for a command line that was given something else. */
function idsOf(list) {
  var out = []
  for (var i = 0; i < list.length; i++) out.push(list[i].id)
  return out.join(", ")
}

/* ------------------------------------------------------------------- paint */

function rgba(c, a) {
  return "rgba(" + Math.round(clamp(c[0]) * 255) + "," + Math.round(clamp(c[1]) * 255)
    + "," + Math.round(clamp(c[2]) * 255) + "," + clamp(a).toFixed(3) + ")"
}

/** The colour an error collapses the band towards. */
var ALARM = [1.0, 0.24, 0.2]

/**
 * One layer's colour as it is actually drawn: pulled towards the alarm red by
 * `hot`, then towards white as `spectrum` closes.
 */
function layerColor(c, w) {
  var r = lerp(c[0], ALARM[0], w.hot)
  var g = lerp(c[1], ALARM[1], w.hot)
  var b = lerp(c[2], ALARM[2], w.hot)
  return [lerp(1, r, w.spectrum), lerp(1, g, w.spectrum), lerp(1, b, w.spectrum)]
}

/**
 * One layer's polyline across the orb, in canvas units.
 *
 * `yawBias` is the lean: it shifts the gaussian's centre rather than the band,
 * so the energy gathers on one side and the band still spans the ball.
 */
function layerPoints(frame, spread, out) {
  var w = frame.wave
  var R = frame.radius
  var pts = out || []
  pts.length = 0
  for (var i = 0; i <= BAND_STEPS; i++) {
    var x = -1 + (2 * i) / BAND_STEPS
    var y = bandAt(w, x - frame.yaw, frame.phase, spread) + (frame.lift - w.lift)
    pts.push({ x: x * R, y: y * R })
  }
  return pts
}

function strokeBand(ctx, pts, color, width, alpha) {
  if (alpha <= 0.002 || width <= 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  // A quadratic through the midpoints: the band is sampled densely enough that
  // this only removes the faceting, and it costs nothing next to a per-point
  // curve fit.
  for (var i = 1; i < pts.length - 1; i++) {
    var mx = (pts[i].x + pts[i + 1].x) / 2
    var my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.globalAlpha = alpha
  ctx.stroke()
}

/**
 * Fills everything on one side of the band: `dir` -1 for above it, 1 for below.
 *
 * The path runs along the band and then out to well past the clip on three
 * sides. Reaching 3R rather than R is not slack — the ball is rotated by the
 * tilt while this is drawn, and a rectangle that only just covered the circle
 * would leave a corner of it bare at 45 degrees.
 */
function fillSide(ctx, pts, dir, R, style) {
  var far = dir * 3 * R
  var last = pts[pts.length - 1]
  ctx.beginPath()
  ctx.moveTo(-3 * R, pts[0].y)
  ctx.lineTo(pts[0].x, pts[0].y)
  for (var i = 1; i < pts.length - 1; i++) {
    var mx = (pts[i].x + pts[i + 1].x) / 2
    var my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  ctx.lineTo(last.x, last.y)
  ctx.lineTo(3 * R, last.y)
  ctx.lineTo(3 * R, far)
  ctx.lineTo(-3 * R, far)
  ctx.closePath()
  ctx.fillStyle = style
  ctx.globalAlpha = 1
  ctx.fill()
}

/**
 * Draws one sampled frame onto a Canvas context whose origin is the orb's
 * centre.
 *
 * `palette` is the four layer colours; `paper` is the desktop's background,
 * which the glass tints towards at its crown so the orb sits on the wallpaper
 * rather than floating in front of it.
 *
 * The order is the original's four passes, minus the one this cannot do: the
 * ball's ground, the band accumulated additively inside a circular clip, then
 * the glass on top. There is no refraction pass — the sampling that would need
 * is the one thing a 2D canvas has no way to express — so the shell's
 * `refract` bends the highlight instead, which is what the eye actually reads
 * at this size.
 */
function paint(ctx, frame, palette, paper) {
  var R = frame.radius
  var w = frame.wave
  var sh = frame.shell
  var i

  var ground = parseHex(paper)
  var alpha = frame.alpha === undefined ? 1 : frame.alpha

  ctx.save()
  ctx.globalAlpha = 1

  /* ---- the halo: what leaks out of the glass, drawn before the ball ---- */

  if (sh.rim > 0) {
    var halo = ctx.createRadialGradient(0, 0, R * 0.86, 0, 0, R * (DEMI_VIEWBOX / RAYON))
    halo.addColorStop(0, rgba(palette[1], 0.16 * w.intensity * alpha))
    halo.addColorStop(0.45, rgba(palette[2], 0.06 * w.intensity * alpha))
    halo.addColorStop(1, rgba(palette[2], 0))
    ctx.beginPath()
    ctx.arc(0, 0, R * (DEMI_VIEWBOX / RAYON), 0, TAU)
    ctx.fillStyle = halo
    ctx.fill()
  }

  /* ------------------------- inside the ball ------------------------- */

  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, R, 0, TAU)
  ctx.clip()

  // The tilt turns the ball's INSIDE, ground and all, not just the band. That
  // is why the crown and the pool are drawn inside this rotation: they are the
  // light in the glass, and light that stayed level while the band rolled would
  // read as a picture of an orb rather than as one.
  ctx.save()
  ctx.rotate(frame.tilt * Math.PI / 180)

  // The ground the band is suspended in: dark above it, light pooled below.
  //
  // The original gets this asymmetry out of its glass composite's key and fill
  // angles, over a symmetric wave. Hanging it on the band instead costs nothing
  // and buys the thing that composite cannot do — the dark and the light MOVE
  // with the wave, so the ball looks full of something rather than painted with
  // a gradient.
  var mid = layerPoints(frame, 0, [])

  if (sh.crown > 0) {
    var crown = ctx.createLinearGradient(0, -R, 0, R * 0.2)
    crown.addColorStop(0, rgba([ground[0] * 0.22, ground[1] * 0.22, ground[2] * 0.3], sh.crown * alpha))
    crown.addColorStop(0.55, rgba([ground[0] * 0.4, ground[1] * 0.4, ground[2] * 0.55], sh.crown * 0.7 * alpha))
    crown.addColorStop(1, rgba([ground[0] * 0.5, ground[1] * 0.5, ground[2] * 0.7], 0))
    fillSide(ctx, mid, -1, R, crown)
  }

  if (sh.floor > 0) {
    var pool = ctx.createLinearGradient(0, -R * 0.1, 0, R)
    pool.addColorStop(0, rgba(palette[2], 0.1 * sh.floor * alpha))
    pool.addColorStop(0.35, rgba([1, 1, 1], 0.34 * sh.floor * alpha))
    pool.addColorStop(1, rgba([1, 1, 1], 0.72 * sh.floor * alpha))
    fillSide(ctx, mid, 1, R, pool)
  }

  // Everything from here is ADDITIVE. That is the whole of the "lit from
  // inside" read: overlapping crests climb past white while the tails stay
  // saturated, which is what the original's pow(x, 1.5) before the clip does.
  ctx.globalCompositeOperation = "lighter"

  var core = Math.max(0.6, w.thickness * R)
  var pts = []

  // The fill between the outermost pair, drawn first and dimmest: it is the
  // body of the band, and the strokes are its edges.
  if (w.bandFill > 0.01) {
    var lo = layerPoints(frame, LAYERS[0].spread, [])
    var hi = layerPoints(frame, LAYERS[3].spread, [])
    ctx.beginPath()
    ctx.moveTo(lo[0].x, lo[0].y)
    for (i = 1; i < lo.length; i++) ctx.lineTo(lo[i].x, lo[i].y)
    for (i = hi.length - 1; i >= 0; i--) ctx.lineTo(hi[i].x, hi[i].y)
    ctx.closePath()
    var fill = ctx.createLinearGradient(-R, 0, R, 0)
    fill.addColorStop(0, rgba(layerColor(palette[0], w), 0))
    fill.addColorStop(0.3, rgba(layerColor(palette[1], w), 0.5 * w.bandFill * w.intensity * alpha))
    fill.addColorStop(0.7, rgba(layerColor(palette[2], w), 0.5 * w.bandFill * w.intensity * alpha))
    fill.addColorStop(1, rgba(layerColor(palette[3], w), 0))
    ctx.fillStyle = fill
    ctx.globalAlpha = 1
    ctx.fill()
  }

  // Each layer three times: a wide dim haze, a mid glow, and a tight core. The
  // original gets this gradient from `intensity / (dist + thickness)`, which is
  // a continuous falloff; three strokes is the cheapest thing that reads the
  // same at a companion's size.
  for (i = 0; i < LAYERS.length; i++) {
    var col = layerColor(palette[i] || LAYERS[i].rgb, w)
    layerPoints(frame, LAYERS[i].spread, pts)
    strokeBand(ctx, pts, rgba(col, 0.085 * w.intensity * alpha), core * 9, 1)
    strokeBand(ctx, pts, rgba(col, 0.16 * w.intensity * alpha), core * 3.5, 1)
    strokeBand(ctx, pts, rgba(col, 0.34 * w.intensity * alpha), core * 1.2, 1)
  }

  // The white heart. Drawn on the mean of the two centre layers so it sits
  // where the crests actually agree, which is where the original goes white.
  layerPoints(frame, 0, pts)
  strokeBand(ctx, pts, rgba(layerColor([1, 1, 1], w), 0.34 * w.intensity * alpha), core * 0.9, 1)

  ctx.globalCompositeOperation = "source-over"
  ctx.restore()

  // The glass darkening towards the rim, from inside: this is what closes the
  // sphere. Without it the band runs flat into the clip and the ball reads as a
  // hole with light in it.
  if (sh.rim > 0) {
    var vign = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, R)
    vign.addColorStop(0, "rgba(0,0,0,0)")
    vign.addColorStop(1, rgba([ground[0] * 0.4, ground[1] * 0.4, ground[2] * 0.5], 0.5 * sh.rim * alpha))
    ctx.fillStyle = vign
    ctx.fillRect(-R, -R, 2 * R, 2 * R)
  }

  ctx.restore()

  /* ----------------------------- the glass ----------------------------- */

  // The specular: an off-centre highlight up and to the left, bent by the
  // shell's `refract`. This is the only thing standing in for the refraction
  // pass, and it is doing most of the work of making the ball look solid.
  if (sh.spec > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, TAU)
    ctx.clip()
    var hx = -R * 0.3
    var hy = -R * (0.42 + 0.1 * sh.refract)
    var spec = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.72)
    spec.addColorStop(0, rgba([1, 1, 1], 0.4 * sh.spec * alpha))
    spec.addColorStop(0.45, rgba([1, 1, 1], 0.08 * sh.spec * alpha))
    spec.addColorStop(1, "rgba(255,255,255,0)")
    ctx.fillStyle = spec
    ctx.fillRect(-R, -R, 2 * R, 2 * R)
    ctx.restore()
  }

  // The rim light: a hairline round the edge, brightest at the bottom where a
  // glass ball catches what is under it.
  if (sh.rim > 0) {
    var rim = ctx.createLinearGradient(0, -R, 0, R)
    rim.addColorStop(0, rgba([1, 1, 1], 0.1 * sh.rim * alpha))
    rim.addColorStop(0.5, rgba(palette[2], 0.16 * sh.rim * alpha))
    rim.addColorStop(1, rgba([1, 1, 1], 0.42 * sh.rim * alpha))
    ctx.beginPath()
    ctx.arc(0, 0, R - Math.max(0.5, R * 0.012), 0, TAU)
    ctx.strokeStyle = rim
    ctx.lineWidth = Math.max(1, R * 0.024)
    ctx.globalAlpha = 1
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * The orb as a bar icon: a ring with the band across it, in one colour.
 *
 * A bar icon is not a small drawing of the orb, it is a MARK. It carries no
 * glass, no spectrum and no glow, holds still, and takes the bar's own
 * foreground like every glyph beside it — a mark that kept its own colours
 * would be the one unthemed thing in the row and would read as wrong.
 *
 * The band is what makes it recognisable as this character rather than as a
 * circle, so it is drawn at the state's own amplitude and clipped to the ring.
 */
function paintMark(ctx, frame, ink) {
  var R = frame.radius
  var pts = layerPoints(frame, 0, [])

  ctx.globalAlpha = 1
  ctx.strokeStyle = ink
  ctx.fillStyle = ink

  ctx.beginPath()
  ctx.arc(0, 0, R * 0.88, 0, TAU)
  ctx.lineWidth = Math.max(1, R * 0.15)
  ctx.stroke()

  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.88, 0, TAU)
  ctx.clip()
  ctx.rotate(frame.tilt * Math.PI / 180)
  strokeBand(ctx, pts, ink, Math.max(1, R * 0.17), 1)
  ctx.restore()
}
