// The warden, tested against the kernel rather than against a description of
// it. Everything here that needs namespaces and overlayfs is skipped when
// this machine cannot provide them — the plugin behaves the same way, and a
// suite that passed by pretending would be the worst possible outcome for a
// file whose whole job is to be a boundary.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const M = createRequire(import.meta.url)("../keystone/Model.js")

const here = dirname(fileURLToPath(import.meta.url))
const warden = join(here, "..", "bin", "iris-warden")

function run(args, options = {}) {
  return spawnSync(warden, args, { encoding: "utf8", timeout: 120000, ...options })
}

function sandboxWorks() {
  const done = run(["preflight"])
  try {
    return JSON.parse(done.stdout).ok === true
  } catch {
    return false
  }
}

const usable = sandboxWorks()
const roots = []
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "iris-warden-test-"))
  roots.push(root)
  return root
}
process.on("exit", () => {
  for (const root of roots) {
    // overlayfs leaves its own work directory mode 000. It is ours, so the
    // permission comes back before the tree goes.
    spawnSync("chmod", ["-R", "u+rwX", root])
    rmSync(root, { recursive: true, force: true })
  }
})

test("preflight answers about this machine, in JSON, either way", () => {
  const done = run(["preflight"])
  const report = JSON.parse(done.stdout)
  assert.equal(report.schemaVersion, 1)
  assert.equal(typeof report.ok, "boolean")
  assert.equal(done.status, report.ok ? 0 : 1)
  if (!report.ok) {
    assert.ok(report.reasons.length > 0, "a refusal says why")
    // The reason reaches a bubble on someone's desktop. "Unknown option
    // --overlay-src" is true and useless; a version they can act on is not.
    assert.doesNotMatch(report.reasons[0], /Unknown option/,
      "an old bubblewrap should be reported as an old bubblewrap")
  }
})

test("a bubblewrap without --overlay is reported as one, on any machine", () => {
  // Machine-independent, because the machine that proved this was needed is
  // the hosted runner: its bubblewrap reports 0.9 and still refuses the
  // option, so a version comparison is not the test. The message is.
  const root = scratch()
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "bwrap"), [
    "#!/usr/bin/env bash",
    "[ \"$1\" = \"--version\" ] && { echo \"bubblewrap 0.9.0\"; exit 0; }",
    "echo \"bwrap: Unknown option --overlay-src\" >&2",
    "exit 1",
    ""
  ].join("\n"))
  chmodSync(join(bin, "bwrap"), 0o755)

  const done = run(["preflight"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  const report = JSON.parse(done.stdout)
  assert.equal(report.ok, false)
  assert.match(report.reasons[0], /--overlay needs 0\.9 or newer/)
  assert.doesNotMatch(report.reasons[0], /Unknown option/)
})

test("an unknown work directory has staged nothing", () => {
  const root = scratch()
  const workdir = join(root, "work")
  mkdirSync(workdir)
  const done = run(["changes", "--state", join(root, "state"), "--workdir", workdir])
  assert.equal(done.status, 0)
  assert.deepEqual(JSON.parse(done.stdout).changes, [])
})

test("publishing refuses to walk through a symlink it did not put there", () => {
  // The one moment the warden touches the real tree with the agent's own
  // filenames. A link planted in the work directory must be a refusal, not a
  // redirect — a same-user attacker is inside this threat model.
  const root = scratch()
  const workdir = join(root, "work")
  const elsewhere = join(root, "elsewhere")
  mkdirSync(workdir)
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, "keep.txt"), "untouched\n")
  symlinkSync(elsewhere, join(workdir, "sub"))

  // Stand in for what the overlay would have left behind.
  const digest = execFileSync("python3", ["-c",
    "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])",
    workdir], { encoding: "utf8" }).trim()
  const upper = join(root, "state", "stage", digest, "upper")
  mkdirSync(join(upper, "sub"), { recursive: true })
  writeFileSync(join(upper, "sub", "keep.txt"), "REPLACED\n")

  const done = run(["apply", "--state", join(root, "state"), "--workdir", workdir])
  assert.notEqual(done.status, 0)
  assert.match(done.stderr, /refusing to follow sub/)
  assert.equal(readFileSync(join(elsewhere, "keep.txt"), "utf8"), "untouched\n")
})

test("the sandbox has no home, no desktop and no route to the network",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const workdir = join(root, "work")
  mkdirSync(workdir)
  // The network probe is a file of its own: quoting a python program through
  // a bash string through a JavaScript string is how a test ends up asserting
  // that a SyntaxError did not reach the internet.
  writeFileSync(join(workdir, "netprobe.py"), [
    "import socket",
    "try:",
    "    socket.create_connection(('1.1.1.1', 443), timeout=4)",
    "    print('LEAK_NET')",
    "except Exception:",
    "    print('no-net')",
    ""
  ].join("\n"))
  const probe = join(root, "probe")
  writeFileSync(probe, [
    "#!/usr/bin/env bash",
    "echo \"home=$HOME\"",
    `[ -e ${JSON.stringify(process.env.HOME)} ] && echo LEAK_HOME || echo no-home`,
    "echo \"wayland=${WAYLAND_DISPLAY:-none} dbus=${DBUS_SESSION_BUS_ADDRESS:-none} ssh=${SSH_AUTH_SOCK:-none}\"",
    // hyprctl itself is on the read-only system and stays reachable; what it
    // needs is the socket, and that is what the sandbox does not have.
    "ls -d \"${XDG_RUNTIME_DIR:-/run/user/0}\"/hypr > /dev/null 2>&1 && echo LEAK_HYPR || echo no-hypr",
    "python3 netprobe.py",
    "echo \"proxy=$HTTPS_PROXY\"",
    ""
  ].join("\n"))
  chmodSync(probe, 0o755)

  const done = run(["run", "--state", join(root, "state"), "--workdir", workdir,
    "--agent", "claude", "--", probe])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /home=\/iris\/home/)
  assert.match(done.stdout, /\bno-home\b/)
  assert.doesNotMatch(done.stdout, /LEAK_HOME/)
  assert.match(done.stdout, /wayland=none dbus=none ssh=none/)
  assert.match(done.stdout, /\bno-hypr\b/)
  assert.match(done.stdout, /\bno-net\b/)
  assert.doesNotMatch(done.stdout, /LEAK_NET/)
  assert.match(done.stdout, /proxy=http:\/\/127\.0\.0\.1:/)
})

test("writes are staged, shown, and only then real",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  writeFileSync(join(workdir, "edit.txt"), "before\n")
  writeFileSync(join(workdir, "gone.txt"), "doomed\n")
  const probe = join(root, "probe")
  writeFileSync(probe, "#!/usr/bin/env bash\nprintf 'after\\n' > edit.txt\n"
    + "printf 'new\\n' > added.txt\nrm -f gone.txt\nmkdir -p sub\nprintf 'deep\\n' > sub/deep.txt\n"
    + "grep -q after edit.txt && echo agent-sees-its-own-write\n")
  chmodSync(probe, 0o755)

  assert.equal(run(["run", "--state", state, "--workdir", workdir, "--", probe]).status, 0)
  // The agent saw its edit; the desktop did not.
  assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "before\n")
  assert.equal(readFileSync(join(workdir, "gone.txt"), "utf8"), "doomed\n")

  const staged = JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout)
  const byPath = Object.fromEntries(staged.changes.map(c => [c.path, c.kind]))
  assert.equal(byPath["edit.txt"], "modify")
  assert.equal(byPath["added.txt"], "add")
  assert.equal(byPath["gone.txt"], "delete")
  assert.equal(byPath["sub/deep.txt"], "add")

  assert.equal(run(["apply", "--state", state, "--workdir", workdir]).status, 0)
  assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "after\n")
  assert.equal(readFileSync(join(workdir, "added.txt"), "utf8"), "new\n")
  assert.equal(readFileSync(join(workdir, "sub", "deep.txt"), "utf8"), "deep\n")
  assert.throws(() => readFileSync(join(workdir, "gone.txt")))
  assert.equal(JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout).count, 0)
})

test("discarding a turn's writes leaves the work directory as it was",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  writeFileSync(join(workdir, "edit.txt"), "before\n")
  const probe = join(root, "probe")
  writeFileSync(probe, "#!/usr/bin/env bash\nprintf 'after\\n' > edit.txt\n")
  chmodSync(probe, 0o755)
  run(["run", "--state", state, "--workdir", workdir, "--", probe])
  assert.equal(JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout).count, 1)
  assert.equal(run(["discard", "--state", state, "--workdir", workdir]).status, 0)
  assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "before\n")
  assert.equal(JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout).count, 0)
})

test("a desktop command runs only when the person at the desktop says so",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  const witness = join(root, "witness")
  const probe = join(root, "probe")
  writeFileSync(probe, [
    "#!/usr/bin/env bash",
    `iris-do /usr/bin/touch ${JSON.stringify(witness)}; echo "first=$?"`,
    `iris-do /usr/bin/touch ${JSON.stringify(witness)}; echo "second=$?"`,
    ""
  ].join("\n"))
  chmodSync(probe, 0o755)

  // Stand in for the person: refuse the first question, allow the second.
  const answering = join(root, "answer.py")
  writeFileSync(answering, [
    "import json, os, sys, time",
    "folder = sys.argv[1]",
    "pending = os.path.join(folder, 'pending.json')",
    "verdict = os.path.join(folder, 'verdict.json')",
    "answers, seen, stop = ['deny', 'allow'], [], time.time() + 60",
    "while time.time() < stop and len(seen) < 2:",
    "    try: asked = json.load(open(pending))",
    "    except Exception: time.sleep(0.05); continue",
    "    if asked['id'] in seen: time.sleep(0.05); continue",
    "    seen.append(asked['id'])",
    "    print(asked['kind'], '|', ' '.join(asked['display']), flush=True)",
    "    temporary = verdict + '.tmp'",
    "    # A verdict carries the digest of what was shown, the way a click does.",
    "    open(temporary, 'w').write(json.dumps({'id': asked['id'],",
    "        'digest': asked['digest'], 'verdict': answers[len(seen) - 1]}))",
    "    os.replace(temporary, verdict)",
    ""
  ].join("\n"))
  mkdirSync(join(state, "consent"), { recursive: true })

  const person = spawnSync("bash", ["-c",
    `python3 ${JSON.stringify(answering)} ${JSON.stringify(join(state, "consent"))} & `
    + `${JSON.stringify(warden)} run --state ${JSON.stringify(state)} `
    + `--consent-timeout 20 `
    + `--workdir ${JSON.stringify(workdir)} -- ${JSON.stringify(probe)}; wait`],
    { encoding: "utf8", timeout: 120000,
      env: { ...process.env, PATH: `${join(here, "..", "bin")}:${process.env.PATH}` } })

  assert.match(person.stdout, /exec \| 1 "\/usr\/bin\/touch" 2 "/,
    "every element of the exact command was shown")
  assert.match(person.stdout, /first=77/, "a refusal is reported as a refusal")
  assert.match(person.stdout, /second=0/, "and consent is what runs it")
  assert.doesNotMatch(person.stdout, /first=0/)
})

test("a home directory is not a work directory", () => {
  // The overlay makes the work directory the only readable thing outside the
  // read-only system. Pointed at $HOME it would hand back everything the rest
  // of the sandbox withholds, so it is refused before anything is built.
  const done = run(["run", "--workdir", process.env.HOME, "--", "/usr/bin/true"])
  assert.notEqual(done.status, 0)
  assert.match(done.stderr, /refusing to sandbox/)
  assert.match(done.stderr, /name a work directory inside it/)
  assert.notEqual(run(["run", "--workdir", "/", "--", "/usr/bin/true"]).status, 0)
})

test("a missing work directory is created rather than refused",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const workdir = join(root, "Work")
  const done = run(["run", "--state", join(root, "state"), "--workdir", workdir,
    "--create-workdir", "--", "/usr/bin/true"])
  assert.equal(done.status, 0, done.stderr)
  assert.equal(run(["changes", "--state", join(root, "state"), "--workdir", workdir]).status, 0)
})

test("a command too big to show in full is refused, never asked about",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  // Consent to a truncated command is consent to whatever was past the cut.
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  const witness = join(root, "witness")
  const probe = join(root, "probe")
  writeFileSync(probe, [
    "#!/usr/bin/env bash",
    `iris-do /usr/bin/bash -c ${JSON.stringify("#" + "x".repeat(400) + "\ntouch " + witness)}; echo "big=$?"`,
    ""
  ].join("\n"))
  chmodSync(probe, 0o755)
  mkdirSync(join(state, "consent"), { recursive: true })

  const done = run(["run", "--state", state, "--workdir", workdir,
    "--consent-timeout", "20", "--", probe],
    { env: { ...process.env, PATH: `${join(here, "..", "bin")}:${process.env.PATH}` } })
  assert.match(done.stdout, /big=77/, "refused without ever asking")
  assert.equal(existsSync(witness), false, "and certainly without running")
  assert.equal(existsSync(join(state, "consent", "pending.json")), false,
    "no question was put on screen at all")
})

test("a verdict for a different command is not an answer to this one",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  const witness = join(root, "witness")
  const probe = join(root, "probe")
  writeFileSync(probe,
    "#!/usr/bin/env bash\n"
    + `iris-do /usr/bin/touch ${JSON.stringify(witness)}; echo "rc=$?"\n`)
  chmodSync(probe, 0o755)
  mkdirSync(join(state, "consent"), { recursive: true })

  // Answer with the right id and a digest for something else — the shape a
  // replayed or retargeted approval would have.
  const answering = join(root, "answer.py")
  writeFileSync(answering, [
    "import json, os, sys, time",
    "folder = sys.argv[1]",
    "pending = os.path.join(folder, 'pending.json')",
    "verdict = os.path.join(folder, 'verdict.json')",
    "stop = time.time() + 60",
    "while time.time() < stop:",
    "    try: asked = json.load(open(pending))",
    "    except Exception: time.sleep(0.05); continue",
    "    print('digest', asked['digest'], flush=True)",
    "    temporary = verdict + '.tmp'",
    "    open(temporary, 'w').write(json.dumps({'id': asked['id'],",
    "        'verdict': 'allow', 'digest': 'sha256:some-other-command'}))",
    "    os.replace(temporary, verdict)",
    "    break",
    ""
  ].join("\n"))

  const person = spawnSync("bash", ["-c",
    `python3 ${JSON.stringify(answering)} ${JSON.stringify(join(state, "consent"))} & `
    + `${JSON.stringify(warden)} run --state ${JSON.stringify(state)} `
    + `--consent-timeout 20 `
    + `--workdir ${JSON.stringify(workdir)} -- ${JSON.stringify(probe)}; wait`],
    { encoding: "utf8", timeout: 120000,
      env: { ...process.env, PATH: `${join(here, "..", "bin")}:${process.env.PATH}` } })

  assert.match(person.stdout, /digest sha256:/, "a digest was asked about")
  assert.match(person.stdout, /rc=77/, "and an allow for another subject is a refusal")
  assert.equal(existsSync(witness), false)
})

test("a scan names its stage, its work directory by inode, and every entry",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  writeFileSync(join(workdir, "edit.txt"), "before\n")
  const probe = join(root, "probe")
  writeFileSync(probe, "#!/usr/bin/env bash\nprintf 'after\\n' > edit.txt\n"
    + "ln -sf /etc/passwd sneaky\nprintf 'x' > added.bin\n")
  chmodSync(probe, 0o755)
  run(["run", "--state", state, "--workdir", workdir, "--", probe])

  const scan = JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout)
  assert.equal(scan.schemaVersion, 2)
  assert.ok(scan.stageId && scan.digest.startsWith("sha256:"))
  assert.match(scan.workdirId, /^\d+:\d+$/, "the directory itself, not its name")
  assert.equal(scan.complete, true)
  assert.equal(scan.changes.length, scan.count, "the list is the whole set")
  const link = scan.changes.find(c => c.path === "sneaky")
  assert.equal(link.kind, "link")
  assert.equal(link.target, "/etc/passwd", "a link's target is shown")
  const edit = scan.changes.find(c => c.path === "edit.txt")
  assert.equal(edit.mode, "0644")
  assert.match(edit.sha256, /^[0-9a-f]{64}$/, "and content is hashed")
})

test("publishing fails closed when the stage moved after it was read",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  writeFileSync(join(workdir, "edit.txt"), "before\n")
  const probe = join(root, "probe")
  writeFileSync(probe, "#!/usr/bin/env bash\nprintf 'reviewed\\n' > edit.txt\n")
  chmodSync(probe, 0o755)
  run(["run", "--state", state, "--workdir", workdir, "--", probe])

  const scan = JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout)
  // Something rewrites the staging layer between the review and the click.
  writeFileSync(join(state, "stage", scan.stageId, "upper", "edit.txt"), "swapped\n")

  const stale = run(["apply", "--state", state, "--workdir", workdir,
    "--stage", scan.stageId, "--expect", scan.digest])
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /not the ones that were approved/)
  assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "before\n",
    "nothing was published")

  // Re-reviewing produces a digest for what is actually there, and that works.
  const fresh = JSON.parse(run(["changes", "--state", state, "--workdir", workdir]).stdout)
  assert.notEqual(fresh.digest, scan.digest)
  assert.equal(run(["apply", "--state", state, "--workdir", workdir,
    "--stage", fresh.stageId, "--expect", fresh.digest]).status, 0)
  assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "swapped\n")
})

test("an approval for one work directory cannot publish another",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const mine = join(root, "mine")
  const other = join(root, "other")
  mkdirSync(mine)
  mkdirSync(other)
  writeFileSync(join(other, "keep.txt"), "untouched\n")
  const probe = join(root, "probe")
  writeFileSync(probe, "#!/usr/bin/env bash\nprintf 'staged\\n' > keep.txt\n")
  chmodSync(probe, 0o755)
  run(["run", "--state", state, "--workdir", other, "--", probe])
  const scan = JSON.parse(run(["changes", "--state", state, "--workdir", other]).stdout)

  // The approval says "other"; the click arrives naming "mine".
  const crossed = run(["apply", "--state", state, "--workdir", mine,
    "--stage", scan.stageId, "--expect", scan.digest])
  assert.notEqual(crossed.status, 0)
  assert.match(crossed.stderr, /different work directory|nothing staged/)
  assert.equal(readFileSync(join(other, "keep.txt"), "utf8"), "untouched\n")
})

test("a publication cannot land while a turn is still writing",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  writeFileSync(join(workdir, "edit.txt"), "before\n")
  const slow = join(root, "slow")
  writeFileSync(slow, "#!/usr/bin/env bash\nprintf 'mid\\n' > edit.txt\nsleep 3\n")
  chmodSync(slow, 0o755)

  const turn = spawn(warden, ["run", "--state", state, "--workdir", workdir, "--", slow],
    { stdio: "ignore" })
  try {
    // Wait for the turn to have taken the stage, then try to publish under it.
    const deadline = Date.now() + 5000
    let refused = null
    while (Date.now() < deadline) {
      refused = run(["apply", "--state", state, "--workdir", workdir])
      if (refused.status !== 0 && /still writing/.test(refused.stderr)) break
      refused = null
    }
    assert.ok(refused, "publishing during a turn must be refused")
    assert.equal(readFileSync(join(workdir, "edit.txt"), "utf8"), "before\n")
  } finally {
    turn.kill("SIGTERM")
  }
})

test("the answer Iris writes is the answer the broker accepts",
  { skip: usable ? false : "this machine cannot build the sandbox" }, () => {
  // The two sides of the consent exchange are written in different languages,
  // and the digest binding only works if they agree exactly. This drives the
  // real broker with the real reader and the real writer from Model.js — the
  // same calls the service makes — rather than a hand-rolled stand-in that
  // could agree with neither.
  const root = scratch()
  const state = join(root, "state")
  const workdir = join(root, "work")
  mkdirSync(workdir)
  const witness = join(root, "witness")
  const probe = join(root, "probe")
  writeFileSync(probe,
    "#!/usr/bin/env bash\n"
    + `iris-do /usr/bin/touch ${JSON.stringify(witness)}; echo "rc=$?"\n`)
  chmodSync(probe, 0o755)
  const consentDir = join(state, "consent")
  mkdirSync(consentDir, { recursive: true })

  const turn = spawn(warden,
    ["run", "--state", state, "--workdir", workdir, "--consent-timeout", "30",
     "--", probe],
    { encoding: "utf8",
      env: { ...process.env, PATH: `${join(here, "..", "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  turn.stdout.on("data", chunk => { output += chunk })

  let request = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && request === null) {
    try {
      request = M.readConsentRequest(readFileSync(join(consentDir, "pending.json"), "utf8"))
    } catch { request = null }
  }
  assert.ok(request, "the service's own reader understood the broker's question")
  assert.equal(request.kind, "exec")
  assert.deepEqual(request.argv, ["/usr/bin/touch", witness])
  assert.deepEqual(request.lines, ['1 "/usr/bin/touch"', `2 "${witness}"`])
  assert.ok(request.digest.startsWith("sha256:"))

  // ...and the service's own writer, verbatim.
  const reply = join(consentDir, "verdict.json")
  writeFileSync(reply + ".tmp", M.consentVerdict(request.id, "allow", request.digest))
  renameSync(reply + ".tmp", reply)

  const done = Date.now() + 30000
  while (Date.now() < done && !existsSync(witness)) { /* wait for the effect */ }
  assert.ok(existsSync(witness), "an allow written by Model.js is honoured")
  turn.kill("SIGTERM")
})
