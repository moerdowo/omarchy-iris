import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const M = require("../keystone/Model.js")

// Iris.js is a QML JavaScript library: `.pragma library` is a directive the QML
// engine reads, not JavaScript, so Node cannot require it the way it requires
// Model.js. Stripping that line is the whole difference — everything below this
// point is the same code the shell runs.
function loadQmlJs(path, extra = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
    .split("\n")
    .map((line) => (/^\s*\.(pragma|import)\b/.test(line) ? "" : line))
    .join("\n")
  const context = { Math, JSON, isFinite, parseInt, String, Number, Array, Object, ...extra }
  runInNewContext(source, context, { filename: path })
  return context
}

const I = loadQmlJs("../keystone/Iris.js")

// The library was evaluated in its own realm, so everything it returns carries
// that realm's Object prototype and `deepStrictEqual` rejects it on identity
// alone. Comparing the JSON is comparing what the values are, which is what
// these tests are about.
const same = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)

const R = 100

/* ----------------------------------------------------------- the catalogue */

test("the three catalogues are the ones the panel offers", () => {
  same(I.SHELLS.map((s) => s.id), ["glass", "clear", "frosted", "halo", "bare"])
  // six palettes of its own, plus the theme accent
  assert.equal(I.TINTS.length, 7)
  assert.equal(I.TEMPERS.length, 8)
  assert.equal(I.STATES.length, 12)
})

test("every entry has a unique id and a name worth showing", () => {
  for (const list of [I.SHELLS, I.TINTS, I.TEMPERS]) {
    const ids = list.map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length, "ids repeat")
    for (const entry of list) {
      assert.match(entry.id, /^[a-z][a-z0-9-]*$/, `${entry.id} is not a safe id`)
      assert.ok(entry.name && entry.name.trim() === entry.name && entry.name.length <= 20,
        `${entry.id} has no name worth showing`)
    }
  }
})

test("a fresh install is a calm spectrum orb behind glass", () => {
  assert.equal(I.DEFAULT_SHELL, "glass")
  assert.equal(I.DEFAULT_TINT, "spectrum")
  assert.equal(I.DEFAULT_TEMPER, "calm")
  for (const [id, list] of [[I.DEFAULT_SHELL, I.SHELLS], [I.DEFAULT_TINT, I.TINTS],
                            [I.DEFAULT_TEMPER, I.TEMPERS]]) {
    assert.ok(list.some((e) => e.id === id), `${id} is not in its own catalogue`)
  }
})

/* ------------------------------------------------------------- validation */

test("a value out of shell.json never leaves the stage empty", () => {
  for (const junk of ["", " ", "nope", "constructor", "prototype", "__proto__",
                      null, undefined, 0, [], {}]) {
    assert.equal(I.shellId(junk), I.DEFAULT_SHELL, `shell ${String(junk)}`)
    assert.equal(I.tintId(junk), I.DEFAULT_TINT, `tint ${String(junk)}`)
    assert.equal(I.temperId(junk), I.DEFAULT_TEMPER, `temper ${String(junk)}`)
  }
})

test("the settings layer only claims to know its own values", () => {
  assert.ok(I.isShellId("glass") && !I.isShellId("cercle"))
  assert.ok(I.isTintId("ember") && !I.isTintId("rouge"))
  assert.ok(I.isTemperId("lively") && !I.isTemperId("heureux"))
  // Inherited members answer truthy on a bare object; the catalogue must not.
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(I.isShellId(inherited), false, inherited)
    assert.equal(I.isTintId(inherited), false, inherited)
    assert.equal(I.isTemperId(inherited), false, inherited)
  }
})

test("the theme accent is the one tint the renderer has to resolve", () => {
  const accented = I.TINTS.filter((t) => t.accent)
  assert.equal(accented.length, 1)
  assert.equal(accented[0].id, "theme")
  // Four layers either way, and the accent's four are actually built from it.
  const themed = I.paletteFor("theme", "#7aa2f7")
  const fixed = I.paletteFor("ember", "#7aa2f7")
  assert.equal(themed.length, 4)
  assert.equal(fixed.length, 4)
  assert.notEqual(JSON.stringify(themed), JSON.stringify(I.paletteFor("theme", "#f7a27a")),
    "the accent is ignored")
  same(fixed, I.paletteFor("ember", "#f7a27a"), "a fixed tint must not follow the accent")
})

test("an accent arriving with its alpha in front is still read as a colour", () => {
  // QML prints eight digits once a colour has an alpha. Read from the front,
  // `#ff1a1b26` is `ff1a1b` — a different colour that looks plausible enough
  // not to be noticed.
  same(I.paletteFor("theme", "#ff7aa2f7"), I.paletteFor("theme", "#7aa2f7"))
})

test("the panel is handed value/label pairs, which is what its pickers read", () => {
  for (const list of [I.SHELLS, I.TINTS, I.TEMPERS]) {
    const options = I.panelOptions(list)
    assert.equal(options.length, list.length)
    for (const option of options) {
      assert.equal(typeof option.value, "string")
      assert.equal(typeof option.label, "string")
    }
  }
  assert.match(I.idsOf(I.SHELLS), /glass/)
})

/* ------------------------------------------------------------------ moods */

test("every mood the plugin can be in has a state to show it as", () => {
  // The moods Chief.qml and Service.qml actually set.
  for (const mood of ["idle", "parked", "tired", "love", "working", "waiting",
                      "success", "error", "sleeping", "dragged"]) {
    const state = I.stateForMood(mood)
    assert.ok(I.STATES.some((s) => s.id === state), `${mood} shows as ${state}`)
  }
  // and anything else rests rather than throwing
  for (const junk of ["", "nope", "constructor", null, undefined]) {
    assert.equal(I.stateForMood(junk), "idle", String(junk))
  }
})

test("a mood may impose a temper; otherwise the person's choice stands", () => {
  assert.equal(I.temperForMood("tired", "lively"), "dreaming")
  assert.equal(I.temperForMood("love", "lively"), "proud")
  // A mood with nothing to say leaves the chosen temper alone...
  assert.equal(I.temperForMood("idle", "lively"), "lively")
  // ...and a chosen temper that is not a temper still lands somewhere valid.
  assert.equal(I.temperForMood("idle", "nope"), I.DEFAULT_TEMPER)
})

test("an idle shift never carries news, and never repeats what is worn", () => {
  // `restless` is the agitated one; a resting orb must never borrow it for fun,
  // or a person glancing over reads it as something having gone wrong.
  assert.ok(!I.IDLE_TEMPERS.includes("restless"))
  for (const id of I.IDLE_TEMPERS) {
    assert.ok(I.isTemperId(id), `${id} is not a temper`)
  }
  // Never the one already worn, whichever number the generator produces.
  for (const current of I.IDLE_TEMPERS) {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999, 1]) {
      const next = I.idleTemper(() => r, current)
      assert.notEqual(next, current, `${current} repeated at ${r}`)
      assert.ok(I.isTemperId(next), `${current} at ${r} gave ${next}`)
    }
  }
  // `rand` is a function, not a number: passing the number gives NaN for the
  // index and undefined for the temper, which QML then silently refuses.
  assert.ok(I.isTemperId(I.idleTemper(Math.random, "calm")))
})

/* ---------------------------------------------------- standby performances */

test("a performance is a real state held for a sane length of time", () => {
  assert.ok(I.PERFORMANCES.length >= 5)
  for (const p of I.PERFORMANCES) {
    assert.match(p.name, /^[a-z][a-z0-9-]*$/)
    assert.ok(I.STATES.some((s) => s.id === p.state), `${p.name} names no state`)
    assert.equal(I.performanceState(p.name), p.state)
    // Long enough to be noticed, short enough not to be a mood.
    assert.ok(p.seconds >= 1.5 && p.seconds <= 12, `${p.name} runs ${p.seconds}s`)
    assert.equal(I.performanceSeconds(p.name), p.seconds)
  }
  const names = I.PERFORMANCES.map((p) => p.name)
  assert.equal(new Set(names).size, names.length, "performance names repeat")
})

test("a performance never says something is happening", () => {
  // These four are how the plugin reports news. An orb that performed one for
  // its own amusement would be crying wolf, and the next real one would not be
  // believed.
  const news = new Set(["thinking", "notify", "alert", "burst"])
  for (const p of I.PERFORMANCES) {
    assert.ok(!news.has(p.state), `${p.name} performs the news state ${p.state}`)
  }
})

test("performances are handed over as the activity tracks the plugin schedules", () => {
  const tracks = I.performanceTracks()
  assert.equal(tracks.length, I.PERFORMANCES.length)
  for (const track of tracks) {
    // One frame held for the whole performance: Model.activityDuration
    // multiplies frames by holds, which is how a sheet declares its length.
    assert.equal(track.frames, 1)
    assert.equal(track.holds.length, 1)
    assert.equal(track.row, undefined, "a drawn performance has no row")
    assert.equal(M.activityDuration(track), track.holds[0])
    assert.equal(track.holds[0], Math.round(I.performanceSeconds(track.name) * 1000))
  }
})

test("an unknown performance rests rather than throwing", () => {
  for (const junk of ["", "nope", "constructor", "__proto__", null, undefined]) {
    assert.equal(I.performanceState(junk), "idle", String(junk))
    assert.equal(I.performanceSeconds(junk), 0, String(junk))
  }
})

/* ----------------------------------------------------------------- engine */

test("the repertoire covers a turn, an answer, a failure and a rest", () => {
  const seen = new Set(Object.values(I.MOOD_STATE))
  for (const id of ["idle", "thinking", "notify", "burst", "alert", "sleep", "carried"]) {
    assert.ok(seen.has(id), `nothing shows as ${id}`)
  }
})

test("a turn does not dissolve the orb into a progress bar", () => {
  // The whole reason `working` gets its own state here is that it stays the
  // same object: one band, opened up. If the body ever went away the companion
  // would have become a spinner, which is the opposite of the point.
  const engine = I.createEngine(R, "thinking", "glass", "calm")
  const rest = I.createEngine(R, "idle", "glass", "calm")
  let opened = false
  for (let t = 0; t <= 3; t += 0.1) {
    const busy = engine.sample(t)
    assert.ok(busy.wave.amplitude > 0.05, `the band vanished at ${t.toFixed(1)}`)
    assert.ok(busy.wave.intensity > 0.2, `the band went dark at ${t.toFixed(1)}`)
    if (busy.wave.aberration > rest.sample(t).wave.aberration * 1.4) opened = true
  }
  assert.ok(opened, "a turn never opens the spectrum, so it reads as resting")
})

test("an error is red whatever the orb has been dressed in", () => {
  // The one place the character's own palette is overruled: a person who chose
  // Ice still needs an error to look like an error.
  const engine = I.createEngine(R, "alert", "glass", "calm")
  let hottest = 0
  for (let t = 0; t <= 2.4; t += 0.1) hottest = Math.max(hottest, engine.sample(t).wave.hot)
  assert.ok(hottest > 0.7, `alert only reached hot ${hottest}`)
  // and no other state borrows it
  for (const state of I.STATES) {
    if (state.id === "alert") continue
    const other = I.createEngine(R, state.id, "glass", "calm")
    for (let t = 0; t <= 3; t += 0.25) {
      assert.equal(other.sample(t).wave.hot, 0, `${state.id} is hot at ${t}`)
    }
  }
})

test("sampling is a pure function of time, forwards and backwards", () => {
  const engine = I.createEngine(R, "idle", "glass", "calm")
  const at = (t) => JSON.stringify(engine.sample(t))
  const forward = [0.3, 0.9, 1.7, 2.5].map(at)
  // Same dates again, out of order: the same picture, or nothing else in the
  // character can be trusted to hold still for a screenshot.
  assert.equal(at(2.5), forward[3])
  assert.equal(at(0.3), forward[0])
  assert.equal(at(1.7), forward[2])
  assert.equal(at(0.9), forward[1])
})

test("a temper change morphs, and lands exactly on the temper asked for", () => {
  const engine = I.createEngine(R, "idle", "glass", "calm")
  const before = engine.sample(0).wave.freq
  engine.setTemper("restless", 0)
  const mid = engine.sample(0.2).wave.freq
  const after = engine.sample(5).wave.freq
  const target = I.createEngine(R, "idle", "glass", "restless").sample(5).wave.freq
  assert.notEqual(mid, before, "the change cut instead of morphing")
  assert.ok(Math.abs(after - target) < 1e-9, `landed on ${after}, wanted ${target}`)
})

test("a state change arriving mid-fade does not make the orb jump", () => {
  const engine = I.createEngine(R, "idle", "glass", "calm")
  engine.setState("burst", 1)
  const during = engine.sample(1.1).wave.amplitude
  // A second change lands while the first fade is still running. The blend as
  // it stands must be frozen and faded out of, or the picture cuts.
  engine.setState("alert", 1.1)
  const after = engine.sample(1.1).wave.amplitude
  assert.ok(Math.abs(after - during) < 1e-6, `jumped from ${during} to ${after}`)
})

test("a look leans the band and then gives it back", () => {
  const engine = I.createEngine(R, "idle", "glass", "calm")
  const level = engine.sample(0).lift
  engine.setLook(I.lookAt(0, -1, 1), 0)
  const raised = engine.sample(1).lift
  assert.ok(raised < level, "looking up did not raise the band")
  engine.setLook(null, 1)
  const back = engine.sample(3).lift
  assert.ok(Math.abs(back - engine.sample(3).lift) < 1e-9)
  assert.ok(Math.abs(back - level) < 0.05, `the band kept ${back - level} of the lean`)
})

test("noticing you starts and ends holding nothing", () => {
  const seconds = I.performanceSeconds("notice")
  assert.ok(seconds > 0)
  assert.equal(I.noticeLook(0, seconds).mix, 0)
  // It MUST end released, or there is one last slide just as everything should
  // have settled.
  assert.equal(I.noticeLook(seconds, seconds).mix, 0)
  let peak = 0
  for (let t = 0; t <= seconds; t += 0.05) {
    const look = I.noticeLook(t, seconds)
    assert.ok(look.mix >= 0 && look.mix <= 1, `mix ${look.mix} at ${t}`)
    assert.ok(Math.abs(look.wander + look.mix - 1) < 1e-9, "wander must complement mix")
    peak = Math.max(peak, look.mix)
  }
  assert.ok(peak > 0.8, `notice only reached ${peak}`)
})

test("pondering never settles, and never leaves the ball", () => {
  for (let t = 0; t <= 30; t += 0.3) {
    const look = I.ponderLook(t)
    assert.ok(Math.abs(look.yaw) <= 0.35, `yaw ${look.yaw} at ${t}`)
    assert.ok(Math.abs(look.pitch) <= 0.25, `pitch ${look.pitch} at ${t}`)
    assert.ok(look.mix > 0, "pondering released the band")
  }
})

test("a pointer anywhere on screen stays inside the lean the orb can hold", () => {
  for (const nx of [-4, -1, -0.5, 0, 0.5, 1, 4]) {
    for (const ny of [-4, -1, 0, 1, 4]) {
      const look = I.lookAt(nx, ny, 1)
      assert.ok(Math.abs(look.yaw) <= 0.34 + 1e-9, `yaw ${look.yaw}`)
      assert.ok(Math.abs(look.pitch) <= 0.22 + 1e-9, `pitch ${look.pitch}`)
      assert.ok(look.mix >= 0 && look.mix <= 1)
    }
  }
})

/* --------------------------------------------------------------- geometry */

test("every state produces a finite, drawable band at every moment", () => {
  for (const state of I.STATES) {
    for (const temper of I.TEMPERS) {
      const engine = I.createEngine(R, state.id, "glass", temper.id)
      for (let t = 0; t <= 6; t += 0.2) {
        const frame = engine.sample(t)
        for (const [key, value] of Object.entries(frame.wave)) {
          assert.ok(isFinite(value), `${state.id}/${temper.id} wave.${key} is ${value} at ${t}`)
        }
        assert.ok(isFinite(frame.phase) && isFinite(frame.lift) && isFinite(frame.tilt),
          `${state.id}/${temper.id} at ${t}`)
        assert.ok(frame.wave.thickness > 0, `${state.id} has no stroke at ${t}`)
        assert.ok(frame.wave.intensity >= 0, `${state.id} is negative at ${t}`)
        assert.ok(frame.shell && typeof frame.shell.rim === "number")
      }
    }
  }
})

test("the band always fits the frame the canvas reserves", () => {
  // Chief.qml inflates the canvas by OVERFLOW on each side and lowers the
  // ground line by the same amount, so this is what that number has to cover.
  // The band is clipped to the ball, so what has to fit is the ball plus the
  // halo — but a band that swung outside the ball would be silently cropped,
  // and a state that did that is a state whose amplitude is wrong.
  const limit = 1 + I.OVERFLOW * 2
  let reach = 0
  let worst = ""
  for (const state of I.STATES) {
    for (const temper of I.TEMPERS) {
      const engine = I.createEngine(1, state.id, "glass", temper.id)
      for (let t = 0; t <= 5; t += 0.1) {
        const frame = engine.sample(t)
        const w = frame.wave
        // The band's peak: the envelopes only ever reduce it, so amplitude
        // plus the lift and half the stroke bounds every point on it.
        const peak = Math.abs(frame.lift) + w.amplitude + w.thickness
        if (peak > reach) { reach = peak; worst = `${state.id}/${temper.id} at ${t.toFixed(1)}` }
      }
    }
  }
  assert.ok(reach <= limit, `the band reached ${reach.toFixed(3)} of ${limit.toFixed(3)} at ${worst}`)
})

test("the flanks taper to nothing, so the band never runs into the clip", () => {
  // The cosine-squared envelope is the reason the band dies at the ball's edge
  // instead of being cut off by it. Losing it would not throw — it would just
  // quietly turn the orb into a disc with a line across it.
  const engine = I.createEngine(1, "idle", "glass", "calm")
  const frame = engine.sample(1)
  for (const spread of [-1, 0, 1]) {
    const edge = Math.abs(I.bandAt(frame.wave, 1.111, frame.phase, spread) - frame.wave.lift)
    const middle = Math.abs(I.bandAt(frame.wave, 0.25, frame.phase, spread) - frame.wave.lift)
    assert.ok(edge < 1e-6, `the band is ${edge} tall at the flank`)
    assert.ok(middle > edge, "the band is flat in the middle")
  }
})

test("the four layers are spread in phase, which is where the colour comes from", () => {
  // Spreading hue alone gives a flat rainbow stripe; it is the phase offset
  // that makes the band look refracted. If the spreads ever collapse the
  // character loses the one thing it was ported for.
  const spreads = I.LAYERS.map((l) => l.spread)
  assert.equal(new Set(spreads).size, spreads.length, "two layers share a phase")
  assert.equal(I.LAYERS.length, 4)
  const wave = I.createEngine(1, "idle", "glass", "calm").sample(1).wave
  const at = (spread) => I.bandAt(wave, 0.2, 0, spread)
  assert.notEqual(at(-1), at(1), "the outer layers sit on top of each other")
})

/* ------------------------------------------------------------------ paint */

/** A Canvas context that records what it was asked to do. */
function recordingContext() {
  const calls = []
  const handler = {
    get(target, name) {
      if (name === "calls") return calls
      if (name === "createLinearGradient" || name === "createRadialGradient") {
        return () => ({ addColorStop() {} })
      }
      if (typeof name !== "string") return undefined
      return (...args) => { calls.push([name, ...args]) }
    },
    set(target, name, value) { calls.push(["=" + name, value]); return true }
  }
  return new Proxy({}, handler)
}

test("painting clips to the ball and sums the band additively inside it", () => {
  const engine = I.createEngine(R, "idle", "glass", "calm")
  const ctx = recordingContext()
  I.paint(ctx, engine.sample(1), I.paletteFor("spectrum", "#ffffff"), "#101010")
  const names = ctx.calls.map((c) => c[0])
  assert.ok(names.includes("arc"), "the ball is drawn")
  assert.ok(names.includes("clip"), "the band is clipped to the ball")
  assert.ok(names.includes("quadraticCurveTo"), "the band is drawn as curves")
  // Additive accumulation is the whole of the lit-from-inside read.
  const ops = ctx.calls.filter((c) => c[0] === "=globalCompositeOperation").map((c) => c[1])
  assert.ok(ops.includes("lighter"), "the band is not summed additively")
  assert.equal(ops[ops.length - 1], "source-over", "the canvas is left in lighter mode")
  // Nothing is ever filled or stroked before a path has been opened.
  let opened = false
  for (const [name] of ctx.calls) {
    if (name === "beginPath") opened = true
    if (name === "fill" || name === "stroke") assert.ok(opened, "a fill without a path")
  }
  // and every clip is released again, or the rest of the frame is cropped
  assert.equal(names.filter((n) => n === "save").length,
               names.filter((n) => n === "restore").length)
})

test("every state and every shell paints without throwing", () => {
  for (const state of I.STATES) {
    for (const shell of I.SHELLS) {
      for (const tint of I.TINTS) {
        const engine = I.createEngine(R, state.id, shell.id, "calm")
        const ctx = recordingContext()
        I.paint(ctx, engine.sample(1), I.paletteFor(tint.id, "#7aa2f7"), "#101010")
        assert.ok(ctx.calls.length > 0, `${state.id}/${shell.id}/${tint.id}`)
      }
    }
  }
})

test("the bare shell draws no glass, and the glass shell does", () => {
  const bare = recordingContext()
  I.paint(bare, I.createEngine(R, "idle", "bare", "calm").sample(1),
    I.paletteFor("spectrum", "#ffffff"), "#101010")
  const glass = recordingContext()
  I.paint(glass, I.createEngine(R, "idle", "glass", "calm").sample(1),
    I.paletteFor("spectrum", "#ffffff"), "#101010")
  assert.ok(bare.calls.length < glass.calls.length,
    "bare costs as much as glass, so it is drawing something it should not")
  // No rim, so no ring is stroked round the edge and no halo is laid outside it.
  const bareArcs = bare.calls.filter((c) => c[0] === "arc").length
  const glassArcs = glass.calls.filter((c) => c[0] === "arc").length
  assert.ok(bareArcs < glassArcs, "bare still draws the glass's own circles")
})

test("the bar mark is one colour and carries the band", () => {
  const engine = I.createEngine(24, "idle", "bare", "calm")
  engine.setLook(I.lookAt(0, 0, 1), 0)
  const ctx = recordingContext()
  I.paintMark(ctx, engine.sample(1), "#c0caf5")
  const names = ctx.calls.map((c) => c[0])
  const inks = ctx.calls
    .filter((c) => c[0] === "=strokeStyle" || c[0] === "=fillStyle")
    .map((c) => c[1])
  // A mark takes the bar's foreground like every glyph beside it. One that
  // kept its own colours would be the one unthemed thing in the row.
  for (const ink of inks) assert.equal(ink, "#c0caf5", `the mark painted ${ink}`)
  assert.ok(names.includes("arc"), "the ring is drawn")
  assert.ok(names.includes("clip"), "the band is held inside the ring")
  assert.equal(names.filter((n) => n === "save").length,
               names.filter((n) => n === "restore").length)
})

/* --------------------------------------------------------- the plugin's own */

test("a drawn pet declares a renderer instead of a spritesheet", () => {
  const manifest = JSON.parse(readFileSync(new URL("../pets/iris/pet.json", import.meta.url), "utf8"))
  assert.equal(manifest.render, "iris")
  assert.equal(manifest.spritesheetPath, undefined)
  assert.equal(M.resolvePetSize(undefined, manifest.size), manifest.size)
})
