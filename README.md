# Tuesday — standalone

Wear the clothes you already own. This is the port of the Claude artifact to a
plain static site, so it can live on a home screen.

## What this is

- `index.html` — page shell. Loads React and Babel from unpkg, compiles
  `app.jsx` in the browser, mounts the app.
- `app.jsx` — the application, generated from the artifact source. Same code,
  minus the module import and export.
- `storage.js` — IndexedDB behind the same four methods the artifact runtime
  provided (`get`, `set`, `delete`, `list`). This seam is why the port was a
  swap rather than a rewrite.
- `sw.js` — offline shell. Network-first for the app files so updates land,
  cache-first for the pinned CDN scripts.
- `manifest.webmanifest`, the `tuesday-icon-*.png` files — what makes it installable.

## Deploying

Every file goes at the root of the GitHub Pages repo — no folders, matching the
convention used by the other apps. No build step.

An older `apple-touch-icon.png` at the root is unrelated and can stay or go;
this app points at `tuesday-icon-180.png`.

## Getting the wardrobe in

In the artifact version, on the Catalogue tab:

1. **Export catalogue** → copy → paste into **Import** here → *Load this*.
   Brings garments, wear history and outfit records.
2. **Export photos** → one part at a time → paste each into **Import**.
   Catalogue must be loaded first; photo parts are filed against it.

The Catalogue tab shows how many garments have a photo, so a missing part is
visible.

## Known limits

- **Per device.** IndexedDB is local, so phone and laptop hold separate
  wardrobes until the Drive sync layer lands. Do not use both as your real
  copy in the meantime.
- **No tagging.** Adding photos needs the vision API, which needs a key that
  cannot ship in public client-side code. Keep tagging in the artifact until
  the key field exists. Everything else — suggestions, logging, storage,
  export — works here.
- **Compiles in the browser.** Babel adds roughly a second on first load and
  is cached afterwards. Kept deliberately: it means `app.jsx` stays readable
  and editable in one file, with no build step to run before a change.

## Updating the app

Replace `app.jsx`. The service worker fetches it network-first, so a reload
picks it up. On iOS, if a change does not appear, delete the home screen icon
and re-add it — standalone mode caches harder and has its own storage
partition.
