# Bundled pets

One ships with the plugin, and it is drawn rather than blitted.

| Id | What it is | Drawn at |
|---|---|---|
| `iris` | A glass orb with a band of light running through it: four phase-spread sine waves summed additively inside a sphere. Computed every frame, so its glass, tint and resting temper are settings. | 48 px |

Its folder holds no artwork at all — see [../docs/pets.md](../docs/pets.md) for
what a pet with a `render` field is, and the top-level README for its glass,
tints, tempers and idle performances. It wears the theme by being told to:
`Theme accent` is one of the tints it offers, and the glass tints its crown
towards the desktop's own background whatever the band is painted.

It sits where you put it. There is no walk cycle, so *Follow my focus* has
nothing to offer it and the menu leaves it out.

## Your own

The spritesheet engine is still here, so a pet made for this ecosystem works.
Drop a folder with a `pet.json` and its sheet into

```
~/.config/omarchy-iris/pets/<id>/
```

and it appears in the picker beside the bundled one. `~/.config/omapets/pets/<id>/`
is read as well. The format and coordinate system are in
[../docs/pets.md](../docs/pets.md), and
[`../tools/build-atlas.py`](../tools/build-atlas.py) assembles an animated
atlas from your own renders, scaling every source to one shared reference pose
so the pet does not shrink in the rows where something tall rises above
it. A pet that declares a `themeable` hue window is repainted in your theme's
accent by [`../tools/companion-recolor`](../tools/companion-recolor).

Nothing bundled exercises those paths any more, so
[`../tools/coldstart-check`](../tools/coldstart-check) plants a spritesheet pet
in an isolated `HOME` and loads it in a real shell, which is a better test of
the path your pet actually arrives by than bundled artwork was.
