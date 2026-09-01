import QtQuick
import "Iris.js" as Iris
import "Model.js" as Model

// The iris character, drawn rather than blitted.
//
// The plugin's other companions are spritesheets: a grid of drawings, one cell
// shown at a time. This one has no artwork at all. It is a band of light
// computed every frame from four phase-spread sine waves, read through a glass
// ball — so its glass, its palette and its resting temper are settings rather
// than pixels, and changing any of them MORPHS instead of cutting, which no
// sheet of drawings can do.
//
// Everything with a number in it lives in Iris.js. This file is the part that a
// canvas needs and a pure engine must not have: a clock, the desktop's palette,
// and the translation from the plugin's moods to the orb's states.
Canvas {
  id: canvas

  /** The orb's diameter at rest. The canvas is larger; see `overflow`. */
  property int petSize: 56
  property string mood: "idle"
  property string shellId: Iris.DEFAULT_SHELL
  property string tintId: Iris.DEFAULT_TINT
  property string temperId: Iris.DEFAULT_TEMPER
  /** The accent `theme` resolves to, and the ground the glass tints towards. */
  property color accent: "#ffffff"
  property color paper: "#000000"
  // The engine reads colours as hex strings. A QML colour prints its alpha when
  // it has one — `#ff1a1b26`, eight digits — which a front-anchored parse would
  // read as a different colour entirely. Drop the alpha here, where the type is
  // still a colour, rather than parsing around it there.
  readonly property string accentHex: Qt.rgba(accent.r, accent.g, accent.b, 1).toString()
  readonly property string paperHex: Qt.rgba(paper.r, paper.g, paper.b, 1).toString()
  property bool reduceMotion: false
  /** Whether a resting orb changes its temper on its own. */
  property bool tempers: true
  property real shiftChance: 0.25
  /** Window visible and orb on stage; gates the clock. */
  property bool active: true
  property bool dragging: false
  /**
   * The standby performance being played, or null: an activity track from the
   * same machinery the spritesheet pets use. The renderer owns when it ENDS,
   * because a drawn performance has no last frame to run out of.
   */
  property var activity: null
  signal performanceFinished()
  /** Pointer offset from the centre, each -1 to 1, or tracking off. */
  property bool pointer: false
  property real pointerX: 0
  property real pointerY: 0

  // The halo reaches past the orb, so the canvas is wider than it on every side
  // and it is the parent's job not to clip it. Chief.qml lowers the ground line
  // by the same amount.
  readonly property real overflow: petSize * Iris.OVERFLOW
  readonly property real ballRadius: petSize / 2

  anchors.fill: parent
  anchors.margins: -overflow
  renderTarget: Canvas.Image
  antialiasing: true

  /**
   * The mood the orb is actually showing.
   *
   * Being carried outranks everything else: it is the one state the person is
   * causing directly, and answering a drag with last turn's result reads as the
   * companion ignoring them.
   */
  readonly property string shownMood: dragging ? "dragged" : mood
  readonly property string activityName: activity ? String(activity.name || "") : ""

  /**
   * Being carried outranks a performance, which outranks the mood.
   *
   * A performance is only ever offered while the mood is calm, and anything
   * with news to deliver cancels one — so by the time these can disagree, the
   * only thing above a performance is a hand.
   */
  readonly property string shownState: {
    if (dragging) return Iris.stateForMood("dragged")
    if (activityName !== "") return Iris.performanceState(activityName)
    return Iris.stateForMood(mood)
  }

  /**
   * The temper on the resting band: what a mood imposes, else the shift it is
   * wearing on its own, else the chosen one.
   *
   * A mood wins over a shift because a shift is only ever offered while the orb
   * is calm, so a mood arriving mid-shift is news and the shift is not. States
   * that write every number themselves ignore this entirely.
   */
  readonly property string shownTemper:
    Iris.temperForMood(shownMood, shift !== "" ? shift : temperId)

  /** A temper borrowed for a few seconds while resting. */
  property string shift: ""

  // ---------------------------------------------------------------- clock
  //
  // The engine is a pure function of time, so this is the only clock in the
  // character and nothing else keeps state about where an animation is. Seconds
  // since the component was created, which is what every duration in Iris.js is
  // expressed in.
  property real epoch: Date.now() / 1000
  property real now: 0

  readonly property bool animating: active && !reduceMotion

  property var engine: null

  Component.onCompleted: {
    engine = Iris.createEngine(ballRadius, shownState,
                               Iris.shellId(shellId), shownTemper)
    // Reduced motion still gets a picture, just never a moving one: the moment
    // in each state where it reads best.
    now = reduceMotion ? Iris.restingMoment(shownState) : 0
    requestPaint()
  }

  Timer {
    // 30 fps. The band is 48 points and the ball is small, so this costs
    // little; what it buys is the travel and the drift, which is the whole of
    // the resting life.
    interval: 33
    repeat: true
    running: canvas.animating && canvas.engine !== null
    onTriggered: {
      canvas.now = Date.now() / 1000 - canvas.epoch
      canvas.driveLook()
      canvas.requestPaint()
    }
  }

  // An orb that has been away comes back where it left off rather than where
  // the wall clock says: the alternative is a jump on every unhide.
  onActiveChanged: if (active) epoch = Date.now() / 1000 - now

  onReduceMotionChanged: {
    if (engine) {
      if (reduceMotion) {
        // Moving `now` back to the resting moment is not enough on its own: the
        // engine measures a state from when that state STARTED, so an orb that
        // has been resting for eight minutes would be asked for a negative
        // local time and show the state's opening frame instead. Restarting it
        // puts the two clocks back in step.
        engine.reset(shownState, 0)
        engine.setLook(null, 0)
        now = Iris.restingMoment(shownState)
      } else epoch = Date.now() / 1000 - now
    }
    requestPaint()
  }

  // ------------------------------------------------------------- settings
  //
  // Each of these is a dated setter on the engine, never a variable read during
  // a sample: that is what keeps `sample(t)` a pure function of time, and with
  // it the promise that the same date always draws the same picture.

  /**
   * The date to hand a setter so that its morph is already over.
   *
   * With reduced motion the clock does not advance, so a morph started at `now`
   * would be frozen partway through it forever — a band stuck between calm and
   * lively. Backdating it past the longest morph lands on the value that was
   * asked for, which is what "no motion" should mean.
   */
  function settleAt() { return reduceMotion ? now - 10 : now }

  onShownStateChanged: {
    if (!engine) return
    if (reduceMotion) {
      // A state is an animation, not a value, so it cannot be backdated into
      // place: at t = 10 `burst` has long since finished and `spin` is still
      // turning. It is restarted instead, on the moment it reads best frozen.
      engine.reset(shownState, 0)
      now = Iris.restingMoment(shownState)
    } else engine.setState(shownState, now)
    requestPaint()
  }
  // The glass has no morph of its own: it is a treatment rather than a motion,
  // and there is nothing between two of them to pass through.
  onShellIdChanged: if (engine) { engine.setShell(Iris.shellId(shellId)); requestPaint() }
  onShownTemperChanged: if (engine) { engine.setTemper(shownTemper, settleAt()); requestPaint() }
  onPetSizeChanged: {
    // The engine holds its scale, so a change of size is a new engine — rebuilt
    // on the state it was already showing rather than reset to resting.
    //
    // A new engine starts its current state at zero, and `now` is not zero, so
    // it is told where the clock has got to. Without that, resizing while an
    // error was on screen would show the end of that run rather than the run.
    if (!engine) return
    // `petSize / 2` rather than the `ballRadius` binding: a change handler and
    // the bindings that depend on the same property have no guaranteed order
    // between them, so reading the binding here can hand the new engine the
    // radius the OLD size had — an orb that never grows past whatever it was
    // built at. Deriving it costs one division and cannot be stale.
    var next = Iris.createEngine(petSize / 2, shownState,
                                 Iris.shellId(shellId), shownTemper)
    next.reset(shownState, reduceMotion ? now - Iris.restingMoment(shownState) : now)
    engine = next
    requestPaint()
  }
  onTintIdChanged: requestPaint()
  onAccentHexChanged: requestPaint()
  onPaperHexChanged: requestPaint()

  // --------------------------------------------------------------- pointer
  //
  // The band leans towards the pointer while it is over the orb. `mix` is ramped
  // by the engine's own catch-up rather than by an animation here, so the lean
  // never quite reaches a cursor that is still moving — which is what makes it
  // read as attending rather than as being pinned.
  onPointerXChanged: aim()
  onPointerYChanged: aim()
  onPointerChanged: aim()

  function aim() {
    if (!engine || reduceMotion) return
    if (pointer) { engine.setLook(Iris.lookAt(pointerX, pointerY, 1), now); driving = false }
    // A pointer leaving does not hand the lean straight back to the state: a
    // script may still want it, and `driveLook` is what decides.
    else driveLook()
    requestPaint()
  }

  /** Whether a script currently holds the lean, so it is released exactly once. */
  property bool driving: false

  /**
   * The scripted lean, evaluated each frame.
   *
   * A real pointer outranks every script: the orb should attend to the person
   * rather than through them at where the script says.
   */
  function driveLook() {
    if (!engine || reduceMotion || pointer) return
    if (activityName === "notice") {
      engine.setLook(Iris.noticeLook(now - activityAt,
                                     Iris.performanceSeconds(activityName)), now, 0.05)
      driving = true
      return
    }
    if (shownMood === "working") {
      engine.setLook(Iris.ponderLook(now), now)
      driving = true
      return
    }
    // Nothing wants it any more. Handing it back every frame would restart the
    // catch-up every frame and the band would never quite arrive.
    if (driving) { engine.setLook(null, now); driving = false }
  }

  // ---------------------------------------------------------- performances
  //
  // A spritesheet performance ends when its row runs out of frames. A drawn one
  // has no frames, so its length is declared and this is what enforces it; the
  // service is told the same way the sprite viewport tells it.
  property real activityAt: 0

  onActivityNameChanged: {
    activityAt = now
    performanceEnd.stop()
    if (activityName !== "") {
      performanceEnd.interval = Math.max(400,
        Math.round(Iris.performanceSeconds(activityName) * 1000))
      performanceEnd.restart()
    } else if (engine && !reduceMotion) engine.setLook(null, now)
    requestPaint()
  }

  Timer { id: performanceEnd; onTriggered: canvas.performanceFinished() }

  // ---------------------------------------------------------------- shifts
  //
  // The same offer-and-hold cadence the sprite pets use for their idle faces,
  // so a person who changes companion does not also change how lively their
  // desktop is.
  Timer {
    id: shiftOffer
    interval: 7000
    repeat: true
    running: canvas.active && canvas.tempers && !canvas.reduceMotion
    onTriggered: {
      shiftOffer.interval = 7000 + Math.round(Math.random() * 8000)
      if (canvas.shift !== "" || canvas.dragging) return
      // Only while nothing is happening: a temper borrowed for fun while an
      // agent is working would be read as news about the agent.
      if (canvas.mood !== "idle" && canvas.mood !== "parked") return
      if (canvas.shiftChance <= 0 || Math.random() > canvas.shiftChance) return
      canvas.shift = Iris.idleTemper(Math.random, Iris.temperId(canvas.temperId))
      shiftBack.interval = Model.glanceMs(Math.random)
      shiftBack.restart()
    }
  }
  Timer { id: shiftBack; onTriggered: canvas.shift = "" }
  onTempersChanged: if (!tempers) shift = ""
  onMoodChanged: if (mood !== "idle" && mood !== "parked") shift = ""

  // ----------------------------------------------------------------- paint
  onPaint: {
    if (!engine) return
    var ctx = getContext("2d")
    ctx.reset()
    // `reset` returns the drawing STATE to its defaults; what is already on the
    // canvas is not part of that state. Without this the previous frame stays
    // under this one and the orb smears as it moves.
    ctx.clearRect(0, 0, width, height)
    ctx.save()
    // The engine works in a frame centred on the orb; the canvas does not.
    ctx.translate(width / 2, height / 2)
    Iris.paint(ctx, engine.sample(now),
               Iris.paletteFor(tintId, accentHex), paperHex)
    ctx.restore()
  }
}
