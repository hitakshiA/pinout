# pinout.club, build plan

Structure taken from Claude Cowork. Visual identity taken from our landing page.
The point is that a person who has used Cowork knows where everything is, and
nobody mistakes this for Anthropic's product.

## What the reference establishes

### Shell

Three regions, and the third only appears when there is something to show.

- **Sidebar, ~300px.** Traffic lights, panel toggle and search along the top. A
  two-up segmented control. Then a flat nav list: New, Projects, Artifacts,
  Scheduled, Customize, each with a small line icon. Then sectioned lists under
  quiet headers, `Pinned` and `Recents`, every row a circle glyph plus a title
  that truncates. The open chat is a filled pill and swaps its glyph. A user row
  sits at the bottom.
- **Transcript, centred column ~740px.** Not full width, and it stays centred
  when the sidebar closes.
- **Artifact panel, right, ~50%.** Own header: `name · TYPE`, an action button
  with a chevron, expand, close.

### The transcript itself

- **User turns** are a rounded rect a shade lighter than the ground, ~12px
  radius, comfortable padding. Not full width.
- **Agent prose is serif**, sitting directly on the background with no bubble.
  That single choice does most of the work of making it feel like a document
  rather than a chat app.
- **Tool activity is one dim sans line under the prose it belongs to**:
  `Loaded tools, searched the web`, `Updated tasks, searched the web`,
  `Searched the web`. Past tense, comma separated, no card, no icon, no
  expansion. Forty calls stay readable because each costs one line.
- **Permission requests are a bordered card**: icon, a question with the subject
  in bold, the exact target in monospace beneath, then buttons left aligned. One
  filled primary and two quiet secondaries.
- **Questions the agent asked** persist as bordered cards, question in serif,
  the answer in muted sans underneath.
- **Work in progress** is a small animated mark plus `doing something… · 2m 1s`.
  Elapsed time is always shown.
- **Finished turns** carry a hover row of small actions and a relative
  timestamp.
- **Artifacts appear inline** as a card: thumbnail, title, `Kind · TYPE`, and an
  action on the right. Clicking opens the right panel.

### Composer

Rounded, bordered, pinned to the bottom of the centre column. Placeholder
`Write a message…`. Below it a row: attach, folder, a mode selector, then on the
right the model, a mic, and a stop/send square. A disclaimer line sits under it.

## What we change

Ours is a **metered agent**, so it grows a fourth thing Cowork has no need of:
money. It goes in the right panel as a session tab beside artifacts and files,
and inline in the transcript at the two moments it matters, asking to spend and
reporting what it spent.

Colours, type and mark come from the landing page: `--bg:#06040d`,
`--purple:#8259ef`, `--lav:#bbb6fd`, Geist for UI. A serif is added for agent
prose because that is the structural idea worth taking.

## The architectural change

Wallets move from the workspace to the **chat**. Each task gets its own account,
balance, bill and history, so two jobs never share a purse. This reverses the
earlier call, which avoided the ~0.81 HBAR account-creation fee per chat.
Isolation is worth the fee.

## Phases

1. **Backend** — per-chat wallets, direct funding with no browser wallet,
   withdraw to any address, HashScan links on every money event.
2. **Shell** — sidebar, centred transcript, right panel, capability in local
   storage, no sign-in.
3. **Transcript** — streaming serif prose, dim tool lines, reasoning, elapsed
   time, artifact cards.
4. **Money** — approval card inline, wallet panel, fund and withdraw, receipts
   linking to HashScan.
5. **Files** — upload, artifacts, preview, download.
6. **Landing** — Try Now opens a fresh workspace, theme carried across.
7. **Deploy** — both apps to the Azure VM under systemd.
8. **Prove** — both demos driven through the UI, every stage watched.

Every phase gets a headless screenshot and a Codex review with the reference
alongside the build.


## A limit worth naming

A job that outlives one session cannot finish, and nothing tells you that is
what happened.

Demo 1 was watched making 31 exec calls across three machines. Each machine hit
the session ceiling, was torn down with its filesystem, and the agent re-rented,
re-staged the input and began again, paying for the same work three times. From
the outside it read as an agent looping stupidly. It was not: it was an agent
being repeatedly reset by an infrastructure limit it had no way to see coming
and no way to survive.

Raising the ceiling buys room and does not fix the shape of it. Two things
would:

- **Tell the agent what it has.** A machine should report the wall clock it is
  allowed, so a job that cannot fit is split rather than discovered halfway.
- **Let progress outlive a machine.** Delivering an intermediate artifact makes
  the next session resume rather than restart, which the chat already supports:
  artifacts are inputs, and stage_input takes them by name.

The second is the real answer, and it is the same idea the four-step pipeline
already proves at the task level, applied one level down.
