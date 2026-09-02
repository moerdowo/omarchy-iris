# Security policy

## Supported version

Security fixes are made on the latest release line. Reproduce a report on the
current version before filing it when practical.

## Reporting a vulnerability

Open a GitHub issue containing only a request for private contact. Do not put
the vulnerability, exploit, tokens, conversation contents, personal paths, or
other user data in that issue. A maintainer will establish a private channel;
include the Omarchy Iris and Omarchy versions, the smallest reproduction you can
provide, and the security boundary crossed there.

Useful reports include command or argument injection, path traversal, unsafe
plugin/config migration, unintended writes outside Omarchy Iris's documented
config and state, duplicate agent execution, or a stale process callback that
can affect a later turn.

## Trust boundary

Omarchy plugins execute unsandboxed inside the long-lived `omarchy-shell`
process. Omarchy Iris does not make that boundary narrower for itself. It does
make it much narrower for the agent it launches.

### Unattended orders

An explicit bubble submission or `omarchy-shell iris order …` call runs the
selected agent inside `bin/iris-warden`: a bubblewrap sandbox with a read-only
system, a private `$HOME` under this plugin's state directory (the agent's own
credential file bound in read-only, nothing else from the real home), no
Wayland, Hyprland, D-Bus or SSH-agent socket, its own empty network namespace
with no resolver, and the work directory mounted through an overlay so its
writes are staged rather than made.

Three actions leave that sandbox, and each requires one explicit answer from
the user before it happens:

- a TCP connection to a host outside the agent's own API allowlist,
- a command run outside the sandbox, submitted through `iris-do`,
- publishing the staged writes into the real work directory.

Each question is **exact**: the subject is displayed in full and structurally —
a command element by element, quoted, with control characters made visible; a
staged change set entry by entry, with link targets, modes and content hashes.
Nothing on the display path truncates. A command whose faithful rendering
exceeds the display budget is refused rather than shortened, and a change set
too large to render whole cannot be approved at all.

Each question is also **bound**: it carries a digest over its canonical subject
(the exact argv and working directory, or the host and port, or the complete
staged set together with the staging layer and the work directory's inode
identity), and a verdict is honoured only if it carries that digest back.
Publication re-derives the digest before acting and fails closed on any
difference, and a turn and a publication hold an exclusive lock on the staging
layer so neither can run under the other.

The broker that asks those questions runs outside the sandbox and is reached
only over a bind-mounted unix socket. Nothing inside can write a verdict,
enumerate pending requests, or reach the state directory the verdicts live in —
that directory is never bound into the sandbox, even when the agent binary sits
beside it. An unanswered question is refused after two minutes.

Where the kernel or the install cannot provide that sandbox, an order is not
run in a weaker mode: it is routed to the interactive console.

### Interactive console sessions

The console launches each agent in its own default mode, with no
automatic-approval or sandbox-bypass flag of any kind, so the agent asks the
user for itself. The user is present; that is the boundary. Opening an empty
console starts no order until one is entered; forwarding an order to it starts
that order immediately.

### What is a security issue here

The agent has the reach the sandbox and the user's consents give it, and it
still holds its own API credential. Reports that show any of the following are
security issues:

- reaching a host, running a command, or changing a file outside the work
  directory without a consent that named it,
- any difference between what a consent card displays and what is then done —
  a truncated, flattened, reordered or otherwise inexact subject,
- an approval that can be replayed, or that can act on a subject other than
  the one it was shown: a command that changed after it was displayed, a
  staging layer other than the reviewed one, or a staged set that moved
  between the review and the publication,
- any path by which the sandboxed process influences a verdict, the consent
  files, this plugin's state, or the shell it runs under,
- publishing staged changes through a symlink or path component the agent
  planted,
- an automatic-approval flag reachable outside the sandbox,
- command or argument injection, path traversal, unsafe plugin/config
  migration, unintended writes outside the documented config and state,
  duplicate agent execution, or a stale process callback that can affect a
  later turn.

Apart from the agent it launches and that agent's brokered connections,
Omarchy Iris's own runtime makes no network request and sends no telemetry. It
must not install agent hooks, edit another application's settings, or execute
an order without a user action or explicit IPC call.
