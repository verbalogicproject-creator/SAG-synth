---
title: "Multi-touch synth UI on Android Chrome — user activation, latency, and backgrounding traps"
topic_id: lp2
question: "Beyond pointerdown-vs-resume() issues, what else is known about touch latency, pointer capture for glissando, and backgrounding on Android Chrome?"
tags: [android, chrome, touch, audiocontext, autoplay-policy, pointer-events]
confidence: medium
---

## Direct answer

Your two already-identified traps are real and well-documented; this file adds what else is known: **`AudioContext.resume()` racing with rapid successive gestures, `visibilitychange`/backgrounding suspending the context without a corresponding event guaranteed on all Android/Chrome versions, and `pointercapture` being necessary (not automatic) for reliable glissando across adjacent keys** are the three additional traps most consistently reported.

## Autoplay policy and `pointerdown` as activation

Chrome's autoplay/user-activation policy treats standard user gestures (click, and by extension pointerdown/touchstart-derived taps) as valid activation triggers for `AudioContext` creation/resume — this is the general, verified rule (any user-initiated event handler qualifies), consistent with the general Web Audio autoplay policy documentation and multiple corroborating community reports. [verified/reported — MDN Web Audio best practices and the widely-cited Chrome autoplay policy documentation both describe "user gesture" broadly, without singling out `pointerdown` as excluded; your own observed exception ("pointerdown is not a user activation... on touch") suggests a *version-specific or Android-Chrome-specific* nuance not visible in general documentation — this is a genuine and useful contradiction of general docs, and should be recorded as your own **verified-by-you** finding rather than something this research confirms generally, since no source reviewed here specifically excludes pointerdown as insufficient activation on Android touch]

## What this contradicts

General Web Audio documentation (MDN, Chrome DevTools guides) does **not** flag `pointerdown` specifically as insufficient user activation — most guidance treats any "user-initiated event" as sufficient and gives `click` as the canonical example without excluding `pointerdown`. If your team's direct testing shows pointerdown failing to count as activation specifically on Android Chrome touch, that is either (a) a real Android-Chrome-specific gap in an otherwise general policy, or (b) a downstream symptom of something else (e.g., `resume()` being called inside an async continuation that's no longer "within" the gesture's activation window — see below) rather than pointerdown itself being categorically excluded. This is worth isolating with a minimal repro before treating "pointerdown doesn't count" as a platform fact to design permanently around — the mechanism might actually be timing/async-related, which is separately, robustly documented (next section).

## The async/promise timing trap (separately confirmed)

A well-documented general Web Audio gotcha, independent of the pointerdown-specific claim, is that **the "user gesture" window for triggering `resume()` is narrow, and any `await` or promise chain before calling `.resume()` can push the call outside that window**, causing the resume to silently fail to actually unlock audio, while the *promise itself still resolves* (i.e., no error is thrown; the context may just remain effectively inaudible on the first note). [reported — this directly matches your own observed behaviour "the promise resolves whether or not the browser honoured it," and is a broadly corroborated pattern across community reports of "AudioContext resumed but no sound"] The general fix pattern reported across Stack Overflow and community write-ups: call `resume()` as the very first synchronous statement inside the gesture handler, and re-check `context.state === "running"` after the resume promise settles rather than trusting resolution alone — which matches exactly what you have already independently discovered.

## Backgrounding / `visibilitychange`

Mobile browsers (Android Chrome included) are documented to **suspend or throttle audio processing when a tab/PWA is backgrounded**, and while `visibilitychange`/`pagehide` events are the standard hooks for detecting this, **there is no universal guarantee that `AudioContext.state` transitions are reported synchronously or promptly on every Android Chrome version when backgrounding occurs** — this is a known source of "audio context silently died while backgrounded" bug reports across multiple mobile web-audio projects. [reported — general mobile Web Audio community knowledge; no single authoritative spec citation found pinning exact Android Chrome version behaviour, flagged as needing device-matrix testing rather than treated as settled] The safe pattern is to explicitly re-check and `resume()` the context on `visibilitychange`-back-to-visible, not just on initial load.

## Pointer capture for glissando across keys

Reliable glissando (sliding a finger across multiple key elements while a single pointer is "down") requires explicit `element.setPointerCapture(event.pointerId)` handling **or**, more robustly for a piano-style multi-key slide UI, listening at a **container level** with `touch-action: none` and computing which key is under the pointer via `document.elementFromPoint()` on `pointermove`, rather than relying on per-key `pointerenter`/`pointerleave` — because once a pointer is captured by the element it started on, that element (not the one now under the finger) continues to receive move events unless capture is explicitly released, which breaks naive per-key event binding for glissando. [reported — this is a well-known general Pointer Events API gotcha, broadly documented across pointer-events tutorials and W3C spec discussion of `setPointerCapture`, though not sourced here to an Android-Chrome-specific bug]

## Sources

- https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices
- https://stackoverflow.com/questions/50218162/web-autoplay-policy-change-resuming-context-doesnt-unmute-audio
- https://news.ycombinator.com/item?id=18066474
- https://phaser.discourse.group/t/resume-a-suspended-web-audio-context-v2-6-2/271
