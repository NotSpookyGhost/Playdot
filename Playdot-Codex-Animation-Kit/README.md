# Playdot animation kit for Codex

This kit contains the selected bounce-up Get Started intro and both subtle idle variants, with their original web sources preserved in separate folders. No framework or existing website is assumed.

## Start here

1. Open [the bounce-up intro preview](01-bounce-up-intro/Playdot-get-started.html) in a browser.
2. Open [the recommended O-lookaround idle](03-lookaround-idle/Playdot-subtle-lookaround.html).
3. The alternative is [the original subtle idle](02-subtle-idle/Playdot-subtle-loop.html).

Each HTML preview is self-contained. The inline SVG markup is the reusable artwork. All animated SVG assets have transparent backgrounds; preview pages and MP4s use navy.

## Folder guide

- `01-bounce-up-intro/`: letters spring up from below the frame, bounce and settle. Plays **once on load**. Includes animated SVG, static SVG, self-contained HTML, separate layout CSS and replay JavaScript, and the original README.
- `02-subtle-idle/`: the original **eight-second seamless loop**, with A blinking/glancing and O gently bobbing. Includes SVG, self-contained HTML with Pause/Resume, and its README.
- `03-lookaround-idle/`: the **recommended default idle**. Same eight-second subtle loop, with the smiling O also looking left and right. Includes SVG, self-contained HTML with Pause/Resume, and its README.
- `previews/`: three silent MP4 references, named to match the source folders.
- `manifest.json`: paths, sizes and SHA-256 checksums for the packaged files.

## Recommended Get Started behavior

Play the bounce-up intro once when the Get Started view mounts. After it finishes, switch to the O-lookaround idle and let that loop. Keep the original idle as an optional quieter alternative.

All three animated assets use the same `2400 × 1350` viewBox and matching resting positions, so keep the same displayed dimensions and alignment during the handoff. The intro's letter motion settles by 2.65 seconds and its final blink animation finishes at about 3.35 seconds. Wait for **all SVG animations to finish** rather than an individual letter's animationend event; the six-second MP4 contains an extra review hold and is not the timing source for the web transition.

Prefer one mounted inline SVG at a time. The assets share `pd-` IDs, classes and some keyframe names. If both intro and idle must coexist in the DOM, give each instance unique IDs and matching references, and scope its CSS/keyframes to prevent cross-animation conflicts.

Honor reduced motion: show the static wordmark immediately and skip the animated transition/idle. The static fallback is [Playdot-get-started-static.svg](01-bounce-up-intro/Playdot-get-started-static.svg). Each supplied animation also includes its own reduced-motion CSS. Preserve accessible replay/pause controls where appropriate.

Use the SVG/web source for the website; the MP4 files are visual references. The HTML files are previews, not pages to drop wholesale into an existing app. In particular, their body/background rules should not replace the host site's global styles. The original READMEs explain the source filenames and controls.

## Ready-to-use direction for Codex

Integrate the assets in this kit into the Get Started view. Use the off-screen bounce-up intro once, then the O-lookaround idle. Preserve the logo proportions, palette, faces and transparent vector artwork. Respect reduced motion, avoid duplicate SVG IDs/style conflicts, and make sure the transition does not shift the logo or replay on unrelated renders. Inspect the project's existing framework and component conventions before implementing.

## Validation and scope

The archive was extracted and checked; source files match their existing bundles byte-for-byte. SVG XML and local filename references were checked. The original animation previews were rendered and verified earlier, including settled poses and loop boundaries. Live browser QA was not available during their creation; run browser checks in the target project before release.

This kit packages existing assets only. It does not implement or deploy a website.
