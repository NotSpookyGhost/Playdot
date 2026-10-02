PLAYDOT — GET STARTED / OFF-SCREEN ENTRANCE

Seven colourful letters spring up from completely below the animation frame. A 150 ms stagger gives each letter a moment; soft squash-and-stretch bounces settle the wordmark, followed by a friendly blink. All letter movement finishes at 2.65 seconds. The brief blink finishes by 3.15 seconds, then the logo stays still.

FILES
- Playdot-get-started.html: self-contained, responsive preview with Replay and reduced-motion support. Open in a modern browser.
- Playdot-get-started.svg: self-contained animated, transparent vector asset.
- Playdot-get-started-static.svg: matching static transparent fallback.
- playdot-get-started.css / .js: preview layout and replay behavior, provided separately for integration. The HTML already contains both. The letter animation CSS is embedded inside the SVG.

WEB INTEGRATION
Use the SVG as an image for the simplest once-on-load entrance. For replay controls, inline its SVG markup inside a container with id="stage", use the button / status markup from the HTML, and include the provided JavaScript. Copy the component layout rules you need; the preview's html/body rules are optional and should not replace the host page's styling. Keep the SVG aspect ratio and overflow clipping so the letters enter from outside the frame. The transparent asset works on a background of your choice; the preview uses navy #111a30.

The animation plays once when loaded and then remains in the final pose. It does not repeat automatically. Replay is opt-in through the button. For a single-page app, mount it once for the Get Started screen rather than remounting on unrelated state changes. No storage, tracking or network access is used.

Reduced motion displays the completed logo immediately. The Replay control is disabled while that preference is enabled. The separate static SVG can also be used as a fallback. If using multiple inline copies, give each copy's pd- IDs and matching references unique names.

PREVIEWS
The silent MP4 is 6 seconds at 1920 × 1080 and 30 fps. Its extended still hold helps review the finish. The GIF repeats for preview convenience; this does not change the website asset's once-on-load behavior.

ARTWORK
Uses the established colourful Playdot vectors traced from the supplied logo, with its character eyes and smiling o preserved. No earlier variants were changed. This is a reusable animation asset, not an implemented or deployed page.
