import QtQuick
import "Iris.js" as Iris

// The orb, as the bar's icon.
//
// Not a shrunken copy of the desktop body: that one animates, and a bar icon
// whose light drifts beside a row of still glyphs is a distraction rather than a
// companion. This holds one pose and repaints only when something it draws
// actually changes.
//
// What it does keep is the identity — a ring with the band across it, at the
// amplitude the mood is actually running at, so the mark in the bar and the orb
// on the desktop are recognisably the same thing. It follows the mood's TEMPER,
// not the mood's state: half the states are a flare or a collapse, and neither
// is legible at seventeen pixels.
Canvas {
  id: mark

  /** Diameter of the orb, in pixels. This is INK, not an em box. */
  property int size: 17
  property string temperId: Iris.DEFAULT_TEMPER
  property string mood: "idle"
  /** The bar's own foreground, so the mark themes with every glyph beside it. */
  property color ink: "#ffffff"

  readonly property string shownTemper:
    Iris.temperForMood(mood, temperId)

  // A little room for the ring's own antialiasing.
  readonly property real pad: Math.ceil(size * 0.12)
  implicitWidth: size + pad * 2
  implicitHeight: size + pad * 2

  renderTarget: Canvas.Image
  antialiasing: true

  /**
   * One fixed instant, not a clock.
   *
   * The engine's resting life is a pure function of time, so any date gives a
   * valid frame; this one is chosen because the band is near its crest there and
   * so reads as a wave rather than as a flat line. Sampling live would mean a
   * timer per bar, per monitor, to animate something the eye should slide over.
   */
  readonly property real pose: 1.0

  function repaintMark() { requestPaint() }
  onSizeChanged: repaintMark()
  onShownTemperChanged: repaintMark()
  onInkChanged: repaintMark()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    ctx.clearRect(0, 0, width, height)
    ctx.save()
    ctx.translate(width / 2, height / 2)
    // `bare` because a mark carries no glass: the shell is gradients, and every
    // one of them is invisible at this size while still costing the fills.
    var engine = Iris.createEngine(size / 2, "idle", "bare", shownTemper)
    // Level, which the orb on the desktop only is when nothing is leaning it.
    // Set well before the sampled instant so the engine's catch-up has finished
    // by then: this is one frozen frame, not an animation arriving.
    engine.setLook(Iris.lookAt(0, 0, 1), 0)
    Iris.paintMark(ctx, engine.sample(pose), String(ink))
    ctx.restore()
  }
}
