# SpokenFrame real-device QA

Run this on the V3 GitHub Pages URL before considering deployment complete.

## Import and reading

- [ ] Import a normal `.fdx`; title, scenes, characters, dialogue, and action appear in the right order.
- [ ] Import a `.fountain`; parentheticals do not appear as spoken passages.
- [ ] Import a normal text-based screenplay PDF; it reaches the player without a warning when the structure is reasonable.
- [ ] Try a scanned PDF; the app explains that a text-based PDF is required.
- [ ] Confirm action is always included and there is no Narration toggle.
- [ ] Confirm the warm gold highlight follows the active passage.

## Cast and audio

- [ ] On a new import, Narrator and every character initially show the same voice.
- [ ] Confirm Narrator is first and the characters with the most dialogue passages appear earlier in the single Cast list.
- [ ] Confirm the choices are named **Premium Audio** and **Standard Audio** and no model/provider terminology appears in the player.
- [ ] Change one character's voice, preview it, close Cast, reopen Cast, and confirm it was saved.
- [ ] Start screenplay playback, open Cast, and preview two voices. Confirm the screenplay pauses, previews never overlap, closing Cast stops the preview, and playback does not restart by itself.
- [ ] Tap **Auto Assign Voices** and confirm voices vary only after that tap.
- [ ] Turn **Read character names** on and confirm the next dialogue says the name first. Turn it off and confirm names are skipped.
- [ ] Confirm the Premium Audio estimate changes when character-name reading changes.
- [ ] Play premium audio, pause, resume, change speed, use Previous/Next Scene, Back/Forward 3, and jump from the scene menu.
- [ ] Replay the same passage and confirm it starts faster from cache.
- [ ] Turn on airplane mode after the next passage has buffered. Confirm the cached/current audio behaves sensibly and a later uncached passage shows a friendly error.
- [ ] Choose **Use Standard Audio** in the premium error message and confirm fallback is explicit.

## Resume

- [ ] Stop in the middle of premium audio and refresh. Resume should return to the same passage and approximately the same time.
- [ ] Close the tab, reopen the site, and use **Continue listening**.
- [ ] Confirm Continue Listening is more prominent than opening a different screenplay.
- [ ] Confirm progress reads like `27% · 1 hr 2 min remaining`, never as an internal unit count.

## Mobile and lock screen

- [ ] Test current Chrome on Android first.
- [ ] Start premium playback, lock the screen, and listen for at least three passage changes.
- [ ] Confirm lock-screen title/speaker metadata appears where supported.
- [ ] Test lock-screen Play/Pause, Previous, and Next where your phone exposes them.
- [ ] Unlock the phone and confirm the highlighted passage matches playback.
- [ ] Test one interruption: start another audio app or receive a call, then return to SpokenFrame.
- [ ] On iPhone/Safari, repeat the test but expect the operating system may suspend the tab. This is a platform limitation, not something the site can guarantee around.

## Layout and accessibility

- [ ] At the narrowest phone size you use, nothing scrolls sideways.
- [ ] Play/Pause and Previous/Next are comfortable touch targets.
- [ ] Screenplay text scrolls independently and remains readable.
- [ ] Tab through the desktop interface with a keyboard; focus is always visible.
- [ ] If your device has Reduce Motion enabled, scrolling/transitions are restrained.

Do not consider V3 fully verified until the import, premium audio, resume, and Android lock-screen rows pass on your actual phone.
