# Working on Omarchy Iris

Omarchy Iris follows Omarchy 4's regular plugin contract. The manifest exposes
one resident `service` and one `bar-widget`:

- `keystone/Service.qml` owns the companion, agent turn, state, and IPC.
- `keystone/BarWidget.qml` is a thin bar control that obtains that singleton
  through `shell.serviceFor(moduleName)`.
- `keystone/Panel.qml` contains the widget's overview and settings popout.
- `keystone/Chief.qml` is presentation and interaction only.
- `keystone/Model.js` contains pure logic covered by Node tests.
- `keystone/Iris.js` is the orb: its wave, its states, its tempers, and the
  translation from this plugin's moods to them. A `.pragma library`, so it
  holds no QML and one copy is shared.
- `keystone/IrisBody.qml` is the part a pure engine must not have: a clock,
  the desktop's palette, and a Canvas.

The split between those two is the same one the rest of the plugin uses.
`Iris.js` has no clock: `sample(t)` is a function of time, and everything
external — the state, the temper, where the pointer is — enters through a
setter that carries a date. That is what makes it testable without a canvas,
and what makes re-reading a past date give back the same picture.
`IrisBody.qml` is its only client.

Keeping state in the service matters. Omarchy creates a bar widget on every
monitor, but there must only ever be one conversation, companion, and IPC
target.

## Local checks

Run these before testing the live desktop:

```bash
omarchy plugin validate .
node --test tests/*.test.mjs
/usr/lib/qt6/bin/qmllint --ignore-settings -W 0 \
  -i /usr/share/omarchy/shell/Commons/qmldir \
  -i /usr/share/omarchy/shell/Ui/qmldir \
  --missing-property disable \
  --signal-handler-parameters disable \
  --unqualified disable \
  keystone/Chief.qml keystone/Service.qml \
  keystone/BarWidget.qml keystone/Panel.qml
tools/coldstart-check
```

The Node suite checks the model, the orb, the
manifest-to-entry-point contract, bundled pet metadata, repository hygiene,
and the service/widget boundary. `tests/iris.test.mjs` loads the QML
JavaScript library by stripping its `.pragma` directive, which is the only
line in it Node cannot read. The
cold-start check is the integration test: it creates an empty HOME and XDG
environment, installs this checkout there with a real `manifest.json` and
`shell.json`, starts a fresh Quickshell process, and requires the bundled
planted spritesheet pet to load. It does not read the developer's installed
pets or plugin settings.

Add `keystone/IrisBody.qml` to that `qmllint` list along with the rest.

## The orb

One generator sits behind it, which does not run at install time and needs
Qt's `qml` tool:

```bash
tools/build-preview       # docs/moods.png and docs/tempers.png
```

It draws both sheets by running `keystone/IrisBody.qml` offscreen and grabbing
what it paints, rather than by re-emitting the character as SVG. That is a
deliberate change from the previous character's generator, which walked the
engine's frames and re-drew them by hand: it worked, and it meant every change
to the renderer had to be made twice or the pictures quietly stopped being of
the thing they claimed to show.

There is no port verifier, and the absence is worth stating. The previous
character was a port of a JavaScript library, so both engines could be run side
by side and diffed character for character. This one ports a WebGL shader onto
a 2D canvas: there is no shared output to compare, and a pixel diff would be
asserting the tuning rather than the geometry. What is checkable is checked in
`tests/iris.test.mjs` — the cosine-squared flank taper, the four layers' phase
spread, the frame the band has to fit inside, and that every state, shell and
tint paints without throwing.

### preview.png

The root `preview.png` is the marketplace listing image and is **not** produced
by that generator. The marketplace scales it to fit a 720px box for the catalog
card and a 1600px box for the detail view, then draws the card into a fixed
175px-tall panel with `object-fit: cover`. A card is therefore a centre crop at
roughly 1.9:1, and a sheet of small labelled cells arrives there as an
unreadable middle slice of itself. The listing image has to be one orb at the
size a person actually sees it.

It is staged and captured by hand, because it is a photograph of the running
plugin rather than a drawing of it:

1. Move to an empty workspace and set a plain dark background. Do not ship a
   capture of a themed wallpaper: the submission checklist asks the submitter
   to confirm ownership of the preview assets, and a desktop background is
   usually somebody else's picture.
2. `omarchy-shell iris bigger 240`, then `omarchy-shell iris place <x>` to put
   the orb where the frame wants it.
3. `omarchy-shell iris ask`, and type a real order into the form without
   sending it.
4. `grim` the output, then crop to 1.9:1 with the form and the orb centred and
   comparable air above and below.
5. Restore the background, the size, and the draft in the form.

Check the result at card size before committing it, not only at full size.

The three constants that were deliberately re-measured for this frame — the
frequency, the aberration and the falloff — are commented at the line that
changes them. A change that moves one of those is changing the character, not
the plumbing: say so in the commit.

Use Qt 6's `qmllint`; `/usr/bin/qmllint` can still be Qt 5 on Omarchy and
silently rejects QML 6 syntax. The three disabled categories are false
positives for shell-injected objects, loader properties, and incomplete
Quickshell qmltypes. `-W 0` turns every other warning into a failure. The
cold-start check remains mandatory because only a real shell process can
exercise manifest injection, plugin discovery, asynchronous file loading,
and the first-render lifecycle.

## Live iteration

Install the committed checkout into a disposable desktop or test account.
`plugin add` clones it into Omarchy's user-owned plugin directory; edit that
installed clone for live iteration:

```bash
omarchy plugin add file:///absolute/path/to/companion --enable
cd ~/.config/omarchy/plugins/io.github.moerdowo.omarchyiris
$EDITOR .
journalctl --user -t omarchy-shell -f
```

Omarchy 4 watches installed plugin files, clears the QML component cache,
rescans the manifest, and reloads the affected service and widget. A shell
restart should not be part of the normal edit loop.

The service writes its public snapshot to
`$XDG_STATE_HOME/omarchy/iris/status.json` (normally
`~/.local/state/omarchy/iris/status.json`). For the running version:

```bash
omarchy-shell iris status
```

The status command and the journal are more reliable than assuming the copy
being edited is the copy currently loaded.

## Visual review

Test at least one narrow and one wide bar, keyboard-only navigation, mouse
navigation, a long agent name, an empty agent list, an invalid custom pet,
reduced motion, an interrupted agent turn, and a multi-monitor layout with a
non-zero monitor origin. Verify a clean start at the bottom-right of the
focused monitor, a one-screen laptop start, delayed monitor focus, and a
previously dragged home. Verify both light and dark themes.

Release screenshots must render the real plugin components at normal scale,
either from an installed copy or from a clean capture harness that loads the
unmodified `Service.qml`, `BarWidget.qml`, `Panel.qml`, and `Chief.qml`. A
harness may supply shell and bar state to stage a reproducible scene, but it
must not redraw or mock the plugin UI. Do not use debug overlays. Check the
chief, order field, answer bubble, overview, and settings panel independently;
a polished hero screenshot cannot hide a broken state.

## Pet work

No spritesheet companion ships: the bundled one is drawn, and its whole body
is `keystone/Iris.js`. The sheet machinery is still here for anybody who
brings their own — `tools/build-atlas.py` assembles an animated atlas and
`tools/build-faces.py` an expression grid from a person's own renders, and
`tools/companion-recolor` is the same deterministic recolouring path used at
runtime.

Nothing bundled exercises those any more, so they are tested against artwork
that is generated rather than shipped: `tools/coldstart-check` plants a pet in
an isolated `HOME` and loads it in a real shell, and the two theming tests in
`tests/menu.test.mjs` build a themeable sheet with ImageMagick. Generated art
is the better fixture — a known hue, an even lightness range, and an exactly
known set of pixels that must not move, none of which anyone had to promise
not to redraw.

The complete schema and drawing rules are in [pets.md](pets.md).

## Release gate

A green development checkout is not a release. The marketplace validates one
public commit, and that exact commit must also be the one tested out of the box.
Before publishing or preparing a marketplace submission:

1. Finish the release commit, then require an empty `git status`. Record
   `release_sha=$(git rev-parse HEAD)` and confirm that the repository's public
   default-branch HEAD resolves to that full 40-character SHA. Never submit a
   dirty working tree, a local-only commit, or a moving commit that was not the
   one reviewed.
2. Clone that public repository into a new temporary directory. Run every
   local check above from the clone, not from the development checkout. Confirm
   `manifest.json`, the changelog version/date, current screenshots, notices,
   and every intended deletion are present in the clone.
3. On a disposable Omarchy 4 user with no Omarchy Iris config, pets, state,
   or prior scratchpad, install with the README command. Accept the normal
   warning and placement prompt. Require one service, one widget, and the
   drawn companion as a small white circle on first paint. With one companion
   bundled the picker has nothing to choose between and is left out.
4. Exercise every visible action once and every setting twice, including the
   return path, keyboard-only use, a narrow and wide bar, multiple monitors,
   fullscreen avoidance, reduced motion, light/dark theme changes, theme off
   and back on, and the ImageMagick-missing fallback.
5. Test no default agent, the desktop default, and every agent Omarchy exposes.
   Bubble-capable agents must stream one turn only. Console-only and explicitly
   selected agents must open the selected CLI, never a stale alias. On the very
   first Quake-console open, require exactly one new
   `org.omarchy.agent` window in `special:scratchpad`; repeat while hidden,
   visible, resumed, and on another monitor.
6. Confirm cancellation, timeout, non-zero exit, agent switching, shell reload,
   and plugin disable leave no descendant process or stale callback capable of
   affecting a later turn. Verify the trust copy against the actual command
   line of each supported CLI version.
7. Upgrade a clean v3.38.0 install through the public update path. Require one
   canonical bar entry, no top-level duplicate, preserved supported settings,
   no resurrected legacy values, and a working service/widget after the live
   reload.
8. Remove through the README command both while idle and while an agent is
   running. Require the service, widget, and child process tree to disappear;
   no hook or external application setting may remain. Only the documented
   state/history directory may survive.
9. Run `tools/build-preview` and look at what comes out. The orb is a port of
   something whose output cannot be diffed, so the release check on the
   character is a person comparing the sheet against the original — not a tool
   asserting it.
10. Require the GitHub checks for `release_sha` to pass. After submission,
    require marketplace compatibility validation and the Automated Security
    Baseline to refer to that same SHA before approval. Re-run the process for
    any changed commit; old evidence does not approve new code.

For the marketplace listing, use category `Desktop` and the tags `ai`,
`bar`, and `quickshell`. Review all five submission checkboxes against the
exact release commit, including ownership or permission for the plugin and
preview assets, before explicitly authorizing the issue.

Publishing, release creation, and marketplace submission are separate,
explicit steps. These checks never commit, push, tag, publish, or submit
anything themselves.
