# Artwork and third-party notices

## Omarchy Companion, and Omarchief before it

Omarchy Iris is a fork of
[Omarchy Companion](https://github.com/moerdowo/omarchy-companion) v2.1.0,
which is itself a fork of
[Omarchief](https://github.com/daventhedude/omarchief) v4.0.0, Copyright (c)
2026 Daven Niemann, distributed under the MIT license that this repository
keeps in [LICENSE](LICENSE). Everything outside `keystone/Iris*.{js,qml}` and
`pets/iris/` is that lineage's work, modified.

The character those projects wore — bloub, a port of
[jeremy-prt/bloub](https://github.com/jeremy-prt/bloub), Copyright (c) 2026
Jérémy Perret, MIT — is not shipped here. It was replaced wholesale by the orb
described below, and `keystone/Bloub.js`, `keystone/BloubFit.js`,
`keystone/BloubBody.qml` and `pets/bloub/` were removed rather than kept
alongside it. They remain in this repository's Git history under the MIT terms
above.

## The orb

`keystone/Iris.js` is a port of the animated orb on <https://maia.id/>, where
it is a Framer code component named `SiriOrb`: a four-pass WebGL2 pipeline
whose wave shader draws four copies of one sine wave, spread in phase across an
RGB spectrum, summed additively and composited into a circular glass panel with
refraction and a rim highlight.

maia.id is the repository author's own site. **The `SiriOrb` component's own
provenance has not been established** — a Framer code component may be
first-party or may come from Framer's marketplace, and the published bundle
carries no licence header either way. Before this repository is made public or
redistributed, that needs to be confirmed and the correct notice recorded here.
Until then it stays private.

What the port carries over is the construction, not the technique: the four
phase offsets, the cosine-squared flank taper, the gaussian that gathers the
band towards the middle, and the additive sum that turns overlapping crests
white while the tails stay saturated. It draws on a QML Canvas rather than in a
fragment shader, so the accumulation is layered strokes instead of per-pixel,
and there is no refraction pass — a 2D canvas cannot sample what is behind it.

Three of the original's constants are deliberately *not* carried over
unchanged, and `keystone/Iris.js` says so at each line that changes them: the
frequency, the aberration and the falloff are all measured over a different
width here than in the original, and transplanting them verbatim does not
reproduce the orb — it strangles the band into a spindle at the centre.

## Omarchy material

Earlier releases of this lineage bundled Gritty, original artwork by Daven
Niemann, and Quattro, adapted from
[`themes/tokyo-night/backgrounds/1-quattro.jpg`](https://github.com/basecamp/omarchy/blob/v4.0.0/themes/tokyo-night/backgrounds/1-quattro.jpg)
in Omarchy v4.0.0, Copyright (c) David Heinemeier Hansson. Neither ships any
more — the only companion is drawn — but both remain in this repository's Git
history, which it inherits from Omarchief, under the MIT terms above.

Omarchy Iris is an independent third-party project. Omarchy, Framer, and all
other third-party names, logos, and marks are the property of their respective
owners. Their appearance identifies material already present in the upstream
work, and does not imply endorsement. Neither the authors of Omarchief nor of
Omarchy Companion are affiliated with this project.
