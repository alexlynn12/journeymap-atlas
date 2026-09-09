# JourneyMap Atlas

An interactive, shareable web map of a Minecraft world, built from the tiles
JourneyMap already renders on your machine. Static site — no server, no
database, hosted free on GitHub Pages.

**Live map:** https://alexlynn12.github.io/journeymap-atlas/

## What it does

- **Every dimension** JourneyMap has mapped — Overworld, Nether, and any modded
  dimension — each with its own layers.
- **Every layer** — surface day and night, topographic, biome, and the 16-block
  underground slices, listed by their Y range.
- **Waypoints** from your in-game waypoint list, searchable, click to fly to.
  Death waypoints show in red.
- **Real block coordinates everywhere.** The readout follows your cursor, and
  clicking anywhere copies `X Z` to the clipboard — plus its Nether/Overworld
  equivalent at the 8:1 portal ratio.
- **Shareable links.** The URL tracks dimension, layer, position and zoom, so
  `…/#overworld/day/-240/512/1` drops someone at exactly what you were looking
  at.
- **Region and chunk grid** overlay for anyone planning builds or farms.

Visitors can explore, search and share. Nobody can edit the map — it is a
read-only view of your JourneyMap data.

## How it works

JourneyMap writes one 512×512 PNG per world region (32×32 chunks), named
`<regionX>,<regionZ>.png`. That is already a slippy-map tile grid at one pixel
per block, so the viewer points Leaflet at those files directly with a Simple
CRS and an identity transformation:

```
LatLng(lat, lng)  ==  LatLng(blockZ, blockX)
```

At zoom 0 one screen pixel is one block; Leaflet scales the same PNGs for every
other zoom level. No tile pyramid to pre-generate, no image stitching.

```
index.html                  the viewer
assets/style.css            styling
assets/app.js               map logic
assets/leaflet.{js,css}     Leaflet 1.9.4, vendored so the page has no CDN dependency
data/manifest.json          dimensions, layers, tile indexes, bounds
data/waypoints.json         waypoints and groups
data/tiles/<dimension>__<layer>__<rx>,<rz>.png
tools/build.py              JourneyMap folder -> data/
```

Tiles sit in one flat folder rather than a directory tree, which is what made it
possible to bootstrap this repo through GitHub's web uploader.

## Updating the map

On Windows, `tools/sync.ps1` does the whole thing — rebuild, commit, push — and
does nothing if the map hasn't changed:

```powershell
git clone https://github.com/alexlynn12/journeymap-atlas.git
cd journeymap-atlas
.\tools\sync.ps1
```

To have it run by itself every morning, once, from that folder:

```powershell
.\tools\sync.ps1 -InstallSchedule -At 04:00
```

That registers a Windows scheduled task called "JourneyMap Atlas sync". Remove
it with `Unregister-ScheduledTask -TaskName 'JourneyMap Atlas sync'`.

Or drive the build yourself, on any platform:

```bash
python3 -m pip install nbtlib
python3 tools/build.py --journeymap "$APPDATA/.minecraft/journeymap" --out .
git add -A && git commit -m "Sync map" && git push
```

Options:

| Flag | Purpose |
| --- | --- |
| `--journeymap` | Path to the `journeymap` folder (the one containing `data/`). Required. |
| `--out` | Site root to write into. Defaults to the current directory. |
| `--world` | World folder name, if JourneyMap has mapped more than one. |
| `--title` | Override the page title. |

The build only copies tiles whose size or timestamp changed, so a routine sync
is a small commit. Quit Minecraft (or at least leave the dimension) before
syncing — JourneyMap flushes its region PNGs to disk lazily.

## Notes

- Waypoints come from `waypoints/WaypointData.dat`, which recent JourneyMap
  versions write as uncompressed NBT. `nbtlib` is only needed for that step; the
  map itself builds without it.
- Underground slice `n` covers `Y = n*16` through `n*16 + 15`.
- Publishing the map publishes your bases. Anything JourneyMap has explored is
  visible to anyone with the link.
- Tiles are binary blobs in git history, so the repo grows over time. If it ever
  gets unwieldy, squash the history or start a fresh orphan branch for `data/`.
