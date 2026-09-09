#!/usr/bin/env python3
"""
Build the static site data from a JourneyMap data folder.

Reads:   <journeymap>/data/<mp|sp>/<World>/...
Writes:  <out>/data/manifest.json
         <out>/data/waypoints.json
         <out>/data/tiles/<dimension>__<layer>__<rx>,<rz>.png

JourneyMap stores one 512x512 PNG per world region (32x32 chunks = 512x512
blocks), named "<regionX>,<regionZ>.png". That is already a tile pyramid at
1 pixel per block, so the viewer consumes them directly.

Layer folders per dimension:
  day / night / topo / biome  -> surface renders
  <integer>                   -> underground slice, 16 blocks tall,
                                 covering Y = n*16 .. n*16+15

Usage:
  python3 tools/build.py --journeymap /path/to/journeymap --out .
  python3 tools/build.py --journeymap /path/to/journeymap --out . --world "World"
"""

import argparse
import json
import os
import re
import shutil
import sys
import time

TILE_RE = re.compile(r"^(-?\d+),(-?\d+)\.png$")
SURFACE_LAYERS = ("day", "night", "topo", "biome")
SKIP_DIRS = {"chunk_cache", "waypoints", "backup"}

DIM_META = {
    "overworld": {"label": "Overworld", "order": 0, "scale": 1},
    "the_nether": {"label": "Nether", "order": 1, "scale": 8},
    "the_end": {"label": "The End", "order": 2, "scale": 1},
}

LAYER_META = {
    "day": {"label": "Surface (day)", "order": 0},
    "night": {"label": "Surface (night)", "order": 1},
    "topo": {"label": "Topographic", "order": 2},
    "biome": {"label": "Biome", "order": 3},
}


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def find_world_dir(jm_root, world_name=None):
    """Return (path, world_label, multiplayer) for the world to publish."""
    candidates = []
    for kind in ("mp", "sp"):
        base = os.path.join(jm_root, "data", kind)
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if os.path.isdir(path):
                candidates.append((path, name, kind == "mp"))

    if not candidates:
        die(f"no worlds found under {os.path.join(jm_root, 'data')}")

    if world_name:
        for cand in candidates:
            if cand[1] == world_name:
                return cand
        names = ", ".join(repr(c[1]) for c in candidates)
        die(f"world {world_name!r} not found. Available: {names}")

    if len(candidates) > 1:
        # Most recently written world wins.
        candidates.sort(key=lambda c: os.path.getmtime(c[0]), reverse=True)
    return candidates[0]


def dim_key(dirname):
    """overworld / the_nether / the_end / minecraft%3Aoverworld / DIM-1 ..."""
    name = dirname.replace("minecraft%3A", "").replace("minecraft:", "")
    aliases = {"DIM-1": "the_nether", "DIM1": "the_end", "DIM0": "overworld"}
    return aliases.get(name, name)


def scan_layer(layer_dir):
    """Return (tiles, bounds, total_bytes) for one layer folder."""
    tiles = []
    total_bytes = 0
    min_x = min_z = max_x = max_z = None
    for entry in os.scandir(layer_dir):
        if not entry.is_file():
            continue
        m = TILE_RE.match(entry.name)
        if not m:
            continue
        rx, rz = int(m.group(1)), int(m.group(2))
        tiles.append([rx, rz])
        total_bytes += entry.stat().st_size
        min_x = rx if min_x is None else min(min_x, rx)
        max_x = rx if max_x is None else max(max_x, rx)
        min_z = rz if min_z is None else min(min_z, rz)
        max_z = rz if max_z is None else max(max_z, rz)
    tiles.sort()
    if not tiles:
        return None, None, 0
    bounds = {"minX": min_x, "maxX": max_x, "minZ": min_z, "maxZ": max_z}
    return tiles, bounds, total_bytes


def copy_tiles(src_dir, dst_dir, tiles, prefix):
    """Copy a layer's region PNGs into a single flat tile folder.

    The flat "<dimension>__<layer>__<rx>,<rz>.png" naming keeps every tile in
    one directory, which is what lets the whole site be uploaded through
    GitHub's web UI in a handful of batches.
    """
    os.makedirs(dst_dir, exist_ok=True)
    copied = 0
    for rx, rz in tiles:
        name = f"{rx},{rz}.png"
        src = os.path.join(src_dir, name)
        dst = os.path.join(dst_dir, f"{prefix}{name}")
        if os.path.exists(dst):
            s, d = os.stat(src), os.stat(dst)
            if s.st_size == d.st_size and int(s.st_mtime) <= int(d.st_mtime):
                continue
        shutil.copy2(src, dst)
        copied += 1
    return copied


def load_waypoints(world_dir):
    """Parse WaypointData.dat (uncompressed NBT) into plain dicts."""
    wp_file = os.path.join(world_dir, "waypoints", "WaypointData.dat")
    if not os.path.exists(wp_file):
        return [], []

    try:
        import nbtlib
    except ImportError:
        print("warn: nbtlib not installed, skipping waypoints "
              "(pip install nbtlib)", file=sys.stderr)
        return [], []

    def unwrap(node):
        if hasattr(node, "items") and not isinstance(node, (str, bytes)):
            return {k: unwrap(v) for k, v in node.items()}
        if isinstance(node, list):
            return [unwrap(v) for v in node]
        try:
            return node.unpack()
        except AttributeError:
            return node

    raw = unwrap(nbtlib.load(wp_file))

    def argb(value):
        if value is None:
            return None
        return "#%06x" % (int(value) & 0xFFFFFF)

    groups = {}
    for gid, g in (raw.get("groups") or {}).items():
        name = g.get("name") or gid
        if name.startswith("jm.waypoint.groups."):
            name = name.split(".")[-2].replace("_", " ").title()
        groups[gid] = {
            "id": gid,
            "name": name,
            "color": argb(g.get("color")),
        }

    waypoints = []
    for wid, w in (raw.get("waypoints") or {}).items():
        pos = w.get("pos") or {}
        dim = pos.get("dimension") or (w.get("dimensions") or [None])[0] or ""
        icon = (w.get("icon") or {}).get("resourceLocation", "")
        waypoints.append({
            "id": w.get("guid") or wid,
            "name": w.get("name") or "Waypoint",
            "x": int(pos.get("x", 0)),
            "y": int(pos.get("y", 64)),
            "z": int(pos.get("z", 0)),
            "dimension": dim_key(dim.split(":")[-1] if ":" in dim else dim),
            "dimensions": [dim_key(d.split(":")[-1]) for d in (w.get("dimensions") or [])],
            "group": w.get("groupId") or "journeymap_default",
            "color": argb(w.get("color")),
            "death": "death" in icon or "death" in (w.get("groupId") or ""),
        })

    waypoints.sort(key=lambda w: w["name"].lower())
    return waypoints, sorted(groups.values(), key=lambda g: g["name"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--journeymap", required=True,
                    help="path to the journeymap folder (contains data/)")
    ap.add_argument("--out", default=".", help="site root to write into")
    ap.add_argument("--world", help="world folder name, if you have several")
    ap.add_argument("--title", help="site title override")
    args = ap.parse_args()

    jm_root = os.path.abspath(os.path.expanduser(args.journeymap))
    out_root = os.path.abspath(os.path.expanduser(args.out))
    if not os.path.isdir(jm_root):
        die(f"not a directory: {jm_root}")

    world_dir, world_name, multiplayer = find_world_dir(jm_root, args.world)
    print(f"world: {world_name}  ({'multiplayer' if multiplayer else 'singleplayer'})")
    print(f"  {world_dir}")

    tiles_root = os.path.join(out_root, "data", "tiles")
    dimensions = []
    total_tiles = 0
    total_copied = 0

    for entry in sorted(os.scandir(world_dir), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        dkey = dim_key(entry.name)
        if dkey in SKIP_DIRS:
            continue

        layers = []
        for sub in sorted(os.scandir(entry.path), key=lambda e: e.name):
            if not sub.is_dir() or sub.name in SKIP_DIRS:
                continue
            is_slice = sub.name.lstrip("-").isdigit()
            if not is_slice and sub.name not in SURFACE_LAYERS:
                continue

            tiles, bounds, layer_bytes = scan_layer(sub.path)
            if not tiles:
                continue

            total_copied += copy_tiles(
                sub.path, tiles_root, tiles, f"{dkey}__{sub.name}__")
            total_tiles += len(tiles)

            if is_slice:
                n = int(sub.name)
                layer = {
                    "id": sub.name,
                    "label": f"Y {n * 16} – {n * 16 + 15}",
                    "kind": "cave",
                    "slice": n,
                    "order": 100 - n,
                }
            else:
                meta = LAYER_META[sub.name]
                layer = {
                    "id": sub.name,
                    "label": meta["label"],
                    "kind": "surface",
                    "order": meta["order"],
                }
            layer["tiles"] = tiles
            layer["bounds"] = bounds
            # Rough proxy for "how much is actually drawn on this layer",
            # used by the viewer to pick a sensible default view.
            layer["detail"] = round(layer_bytes / max(len(tiles), 1))
            layers.append(layer)

        if not layers:
            continue

        layers.sort(key=lambda l: (l["kind"] != "surface", l["order"]))
        meta = DIM_META.get(dkey, {"label": dkey.replace("_", " ").title(),
                                   "order": 9, "scale": 1})
        dimensions.append({
            "id": dkey,
            "label": meta["label"],
            "scale": meta["scale"],
            "order": meta["order"],
            "layers": layers,
        })

    dimensions.sort(key=lambda d: (d["order"], d["label"]))
    if not dimensions:
        die("no map tiles found — has JourneyMap rendered this world yet?")

    waypoints, groups = load_waypoints(world_dir)

    manifest = {
        "generated": int(time.time() * 1000),
        "world": world_name,
        "title": args.title or f"{world_name} — JourneyMap Atlas",
        "multiplayer": multiplayer,
        "tileSize": 512,
        "blocksPerTile": 512,
        "dimensions": dimensions,
        "waypointGroups": groups,
        "counts": {
            "tiles": total_tiles,
            "waypoints": len(waypoints),
            "dimensions": len(dimensions),
        },
    }

    os.makedirs(os.path.join(out_root, "data"), exist_ok=True)
    with open(os.path.join(out_root, "data", "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    with open(os.path.join(out_root, "data", "waypoints.json"), "w") as f:
        json.dump({"waypoints": waypoints, "groups": groups}, f, indent=1)

    for d in dimensions:
        names = ", ".join(l["id"] for l in d["layers"])
        print(f"  {d['label']}: {len(d['layers'])} layers ({names})")
    print(f"tiles: {total_tiles} total, {total_copied} new/changed")
    print(f"waypoints: {len(waypoints)}")


if __name__ == "__main__":
    main()
