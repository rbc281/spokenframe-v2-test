# SpokenFrame real-device QA

Run this on the V4 beta GitHub Pages URL before considering deployment complete.

## Account and private cross-device storage

- [ ] Sign in, upload a screenplay, return Home, and confirm it appears in the library.
- [ ] On a second browser/device, sign in with the same account and select that library entry without re-uploading the file.
- [ ] Confirm the screenplay opens with the saved position, speed, Audio Quality, Read Character Names state, and Cast assignments.
- [ ] For a screenplay already unlocked in the Stripe sandbox, generate one short Premium Audio passage on the first device, then play the identical passage on the second device and confirm it starts from the private cache without a second provider generation.
- [ ] Sign out and confirm the private library disappears while guest import remains available.

## Import and reading

- [ ] Import a normal `.fdx`; title, scenes, characters, dialogue, and action appear in the right order.
- [ ] Import a `.fountain`; parentheticals do not appear as spoken passages.
- [ ] Import a normal text-based screenplay PDF; it reaches the player without a warning when the structure is reasonable.
- [ ] Try a scanned PDF; the app explains that a text-based PDF is required.
- [ ] Confirm action is always included and there is no Narration toggle.
- [ ] Confirm the warm gold highlight follows the active passage.

## Cast and audio

- [ ] On a new import, Standard Audio shows one device voice used for the entire screenplay.
- [ ] After Premium is unlocked, confirm Narrator is first and the characters with the most dialogue passages appear earlier in the single Cast list.
- [ ] Confirm the choices are named **Premium Audio** and **Standard Audio** and no model/provider terminology appears in the player.
- [ ] Change one character's voice, preview it, close Cast, reopen Cast, and confirm it was saved.
- [ ] Start screenplay playback, open Cast, and preview two voices. Confirm the screenplay pauses, previews never overlap, closing Cast stops the preview, and playback does not restart by itself.
- [ ] Tap **Auto Assign Voices** and confirm voices vary only after that tap.
- [ ] Turn **Read character names** on and confirm the next dialogue says the name first. Turn it off and confirm names are skipped.
- [ ] Confirm the Premium offer shows screenplay pages and the correct one-time price, without provider credits or tokens.
- [ ] Play premium audio, pause, resume, change speed, use Previous/Next Scene, Back/Forward 3, and jump from the scene menu.
- [ ] Replay the same passage and confirm it starts faster from cache.
- [ ] Turn on airplane mode after the next passage has buffered. Confirm the cached/current audio behaves sensibly and a later uncached passage shows a friendly error.
- [ ] Choose **Use Standard Audio** in the premium error message and confirm fallback is explicit.

## Stripe sandbox payment — required before enabling enforcement

- [ ] Sign in and upload a screenplay so it appears in the private library.
- [ ] Open Cast, choose **Premium Audio**, and confirm the displayed page count and price match the pricing table.
- [ ] Select **Unlock Premium** and confirm the hosted Stripe sandbox checkout opens.
- [ ] Complete the checkout with Stripe's sandbox test card, not a real card.
- [ ] Confirm SpokenFrame reopens the same screenplay and says Premium Audio is ready.
- [ ] Return Home and confirm that screenplay is labeled **Premium** while another unpaid screenplay remains **Standard**.
- [ ] Generate one very short passage, replay it, and confirm replay does not create another provider request.
- [ ] In Stripe, confirm the webhook delivery returned HTTP 200. In Supabase, confirm exactly one payment and one active entitlement exist for the screenplay.

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

Do not consider V4 ready for public beta until account storage, import, Standard Audio, paid Premium Audio, resume, Android lock-screen, payment entitlement, and public-email tests pass. Keep `PREMIUM_ENTITLEMENTS_REQUIRED=false` until the Stripe sandbox section passes completely.
