from __future__ import annotations

import concurrent.futures
import io
import math

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageDraw, ImageFont

from route_optimizer.config import INDEX_HTML_PATH, get_settings
from route_optimizer.models import MapExportRequest, RouteRequest
from route_optimizer.solver import (
    RouteValidationError,
    UpstreamRoutingError,
    build_block_cost_matrix,
    build_locked_blocks,
    calculate_route_metrics,
    expand_block_route,
    get_osrm_matrices,
    get_osrm_route_path,
    normalize_lock_group,
    solve_tsp_open,
    validate_cost_matrix,
)


settings = get_settings()
app = FastAPI(title="Route Optimizer API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=settings.allow_credentials,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# ── Map Export: Tile Rendering Engine ─────────────────────────────────────────

_TILE_SERVERS: dict[str, str] = {
    "light":   "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "dark":    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "voyager": "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    "streets": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
}
_CARTO_SUBS = ["a", "b", "c", "d"]
_OSM_SUBS   = ["a", "b", "c"]
_TILE_PX    = 256
_MAX_TILES  = 225   # 15 × 15 grid cap
_MAX_ZOOM   = 17


class MapTileFetchError(RuntimeError):
    """Raised when the export renderer cannot fetch a required map tile."""


def _tile_y_f(lat: float, zoom: int) -> float:
    lr = math.radians(lat)
    return (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * (2 ** zoom)


def _tile_x_f(lng: float, zoom: int) -> float:
    return (lng + 180.0) / 360.0 * (2 ** zoom)


def _best_zoom(bounds: "ExportBounds") -> int:  # type: ignore[name-defined]
    for zoom in range(_MAX_ZOOM, 0, -1):
        x0 = int(_tile_x_f(bounds.west, zoom))
        x1 = int(_tile_x_f(bounds.east, zoom))
        y0 = int(_tile_y_f(bounds.north, zoom))
        y1 = int(_tile_y_f(bounds.south, zoom))
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= _MAX_TILES:
            return zoom
    return 2


def _tile_url(style: str, x: int, y: int, z: int, idx: int) -> str:
    tpl = _TILE_SERVERS.get(style, _TILE_SERVERS["voyager"])
    sub = _CARTO_SUBS[idx % 4] if style != "streets" else _OSM_SUBS[idx % 3]
    return tpl.format(s=sub, z=z, x=x, y=y)


def _fetch_tile(args: tuple) -> tuple:
    import requests as _req  # local import keeps module load fast
    style, x, y, z, idx = args
    url = _tile_url(style, x, y, z, idx)
    try:
        r = _req.get(url, timeout=15, headers={"User-Agent": "RouteOptimizerApp/1.0"})
        r.raise_for_status()
        return x, y, Image.open(io.BytesIO(r.content)).convert("RGBA")
    except Exception as exc:
        raise MapTileFetchError(f"Failed to fetch map tile {z}/{x}/{y} from {url}.") from exc


def _hex_rgba(hex_color: str, alpha: float = 1.0) -> tuple:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r, g, b, int(max(0.0, min(1.0, alpha)) * 255)


def _dashed_line(
    draw: ImageDraw.ImageDraw,
    pts: list[tuple],
    fill: tuple,
    width: int,
    dash: int = 20,
    gap: int = 12,
) -> None:
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        dx, dy = x1 - x0, y1 - y0
        dist = math.hypot(dx, dy)
        if dist < 0.5:
            continue
        nx, ny = dx / dist, dy / dist
        d, on = 0.0, True
        while d < dist:
            end = min(d + (dash if on else gap), dist)
            if on:
                draw.line(
                    [(x0 + nx * d, y0 + ny * d), (x0 + nx * end, y0 + ny * end)],
                    fill=fill,
                    width=width,
                )
            d, on = end, not on


def _render_export(req: MapExportRequest) -> tuple[bytes, str]:
    """Stitch tiles, draw route + waypoints, return (image_bytes, content_type)."""
    b = req.bounds
    if b.north <= b.south:
        raise ValueError("North bound must be greater than south bound.")
    if b.east <= b.west:
        raise ValueError("East bound must be greater than west bound.")

    zoom = _best_zoom(b)
    n2   = 2 ** zoom

    x_min = max(0, int(_tile_x_f(b.west,  zoom)))
    x_max = min(n2 - 1, int(_tile_x_f(b.east,  zoom)))
    y_min = max(0, int(_tile_y_f(b.north, zoom)))
    y_max = min(n2 - 1, int(_tile_y_f(b.south, zoom)))

    cw = (x_max - x_min + 1) * _TILE_PX
    ch = (y_max - y_min + 1) * _TILE_PX
    canvas = Image.new("RGBA", (cw, ch), (210, 210, 210, 255))

    tile_args = [
        (req.map_style, x, y, zoom, i)
        for i, (x, y) in enumerate(
            (x, y)
            for x in range(x_min, x_max + 1)
            for y in range(y_min, y_max + 1)
        )
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for tx, ty, tile in pool.map(_fetch_tile, tile_args):
            canvas.paste(tile, ((tx - x_min) * _TILE_PX, (ty - y_min) * _TILE_PX))

    # Helper: geo → stitched-canvas pixel
    def _c(lat: float, lng: float) -> tuple[float, float]:
        return (_tile_x_f(lng, zoom) - x_min) * _TILE_PX, (_tile_y_f(lat, zoom) - y_min) * _TILE_PX

    # Crop canvas to exact bounds
    cx0, cy0 = _c(b.north, b.west)
    cx1, cy1 = _c(b.south, b.east)
    cx0, cy0 = max(0.0, cx0), max(0.0, cy0)
    cx1, cy1 = min(float(cw), cx1), min(float(ch), cy1)
    if cx1 <= cx0 or cy1 <= cy0:
        raise ValueError("Export bounds produced an empty image region.")

    canvas = canvas.crop((int(cx0), int(cy0), int(cx1), int(cy1)))
    crop_w, crop_h = canvas.size

    # Scale to target resolution
    tw, th = req.width, req.height
    canvas = canvas.resize((tw, th), Image.LANCZOS)
    sx, sy = tw / crop_w, th / crop_h

    # Helper: geo → export-image pixel
    def _e(lat: float, lng: float) -> tuple[float, float]:
        px, py = _c(lat, lng)
        return (px - cx0) * sx, (py - cy0) * sy

    draw = ImageDraw.Draw(canvas)
    scale_f = tw / 2048.0

    # ── Draw route ────────────────────────────────────────────────────────────
    if req.show_route and len(req.route_geometry) >= 2:
        pts = [_e(p.lat, p.lng) for p in req.route_geometry]
        thick = max(1, round(req.route_thickness * scale_f))
        casing_thick = thick + max(2, thick // 2)
        route_rgba  = _hex_rgba(req.route_color, req.route_opacity)
        casing_rgba = (255, 255, 255, int(req.route_opacity * 210))

        if req.route_dashed:
            dash_len = max(10, round(20 * scale_f))
            gap_len  = max(6,  round(12 * scale_f))
            _dashed_line(draw, pts, casing_rgba, casing_thick, dash_len, gap_len)
            _dashed_line(draw, pts, route_rgba,  thick,        dash_len, gap_len)
        else:
            draw.line(pts, fill=casing_rgba, width=casing_thick)
            draw.line(pts, fill=route_rgba,  width=thick)

    # ── Draw waypoints ────────────────────────────────────────────────────────
    if req.show_points and req.point_visibility != "none" and req.waypoints:
        wps = req.waypoints
        if req.point_visibility == "start_end" and len(wps) > 2:
            wps = [wps[0], wps[-1]]

        marker_r   = max(3, round(req.point_size * scale_f * 0.55))
        point_rgba = _hex_rgba(req.point_color)
        start_rgba = (22, 163, 74, 230)

        try:
            font_size = max(10, min(28, round(13 * scale_f)))
            font = ImageFont.load_default(size=font_size)
        except TypeError:
            font = ImageFont.load_default()

        for i, wp in enumerate(wps):
            px, py = _e(wp.lat, wp.lng)
            if px < -marker_r * 3 or px > tw + marker_r * 3 or py < -marker_r * 3 or py > th + marker_r * 3:
                continue
            fill = start_rgba if i == 0 else point_rgba

            if req.point_shape == "pin":
                # Teardrop: circle body + downward triangle tail
                pin_r  = max(4, round(req.point_size * scale_f * 0.7))
                tail_h = max(4, round(pin_r * 1.4))
                cx, cy = int(px), int(py - tail_h)     # pin body centre

                # White outer ring
                draw.ellipse([(cx - pin_r - 2, cy - pin_r - 2),
                              (cx + pin_r + 2, cy + pin_r + 2)],
                             fill=(255, 255, 255, 235))
                # Coloured body
                draw.ellipse([(cx - pin_r, cy - pin_r),
                              (cx + pin_r, cy + pin_r)],
                             fill=fill)
                # Tail triangle pointing downward to (px, py)
                tri = [(cx - pin_r // 2, cy + pin_r // 2),
                       (cx + pin_r // 2, cy + pin_r // 2),
                       (int(px), int(py))]
                draw.polygon(tri, fill=fill)
                # White inner dot
                ir = max(1, pin_r // 3)
                draw.ellipse([(cx - ir, cy - ir), (cx + ir, cy + ir)],
                             fill=(255, 255, 255, 210))

                label_ox, label_oy = cx + pin_r + 5, cy - pin_r

            else:
                # Circle (default)
                # White outer ring
                draw.ellipse([(px - marker_r - 2, py - marker_r - 2),
                              (px + marker_r + 2, py + marker_r + 2)],
                             fill=(255, 255, 255, 235))
                draw.ellipse([(px - marker_r, py - marker_r),
                              (px + marker_r, py + marker_r)], fill=fill)
                ir = max(1, marker_r // 3)
                draw.ellipse([(px - ir, py - ir), (px + ir, py + ir)],
                             fill=(255, 255, 255, 220))

                label_ox, label_oy = int(px + marker_r + 5), int(py - marker_r)

            if req.show_point_labels and wp.id:
                label = wp.id if len(wp.id) <= 28 else wp.id[:26] + "…"
                try:
                    bbox = draw.textbbox((label_ox, label_oy), label, font=font)
                    draw.rectangle(
                        [bbox[0] - 2, bbox[1] - 2, bbox[2] + 2, bbox[3] + 2],
                        fill=(255, 255, 255, 200),
                    )
                except AttributeError:
                    pass
                draw.text((label_ox + 1, label_oy + 1), label, font=font, fill=(0, 0, 0, 90))
                draw.text((label_ox, label_oy),          label, font=font, fill=(20, 20, 20, 230))

    # ── Encode ────────────────────────────────────────────────────────────────
    out = io.BytesIO()
    if req.format == "jpeg":
        canvas.convert("RGB").save(out, format="JPEG", quality=92)
        return out.getvalue(), "image/jpeg"
    canvas.save(out, format="PNG")
    return out.getvalue(), "image/png"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=FileResponse)
def serve_ui():
    """Serve the single-page UI."""
    if INDEX_HTML_PATH.exists():
        return FileResponse(INDEX_HTML_PATH)
    raise HTTPException(status_code=404, detail="UI file not found.")


@app.get("/health")
def health_check():
    current_settings = get_settings()
    return {
        "status": "online" if current_settings.is_osrm_configured else "degraded",
        "osrm_configured": current_settings.is_osrm_configured,
    }


@app.post("/api/export-map")
def export_map(request: MapExportRequest) -> Response:
    """Render a high-resolution map image and stream it back."""
    try:
        image_bytes, content_type = _render_export(request)
    except MapTileFetchError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Render failed: {exc}") from exc

    ext = "jpg" if "jpeg" in content_type else "png"
    return Response(
        content=image_bytes,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="map-export.{ext}"'},
    )


@app.post("/api/optimize")
def optimize_route(request: RouteRequest):
    if len(request.locations) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 points to route.")

    current_settings = get_settings()
    if not current_settings.osrm_url:
        raise HTTPException(
            status_code=503,
            detail="OSRM_URL is not configured on the server.",
        )

    try:
        raw_duration_matrix, raw_distance_matrix, snapped_sources = get_osrm_matrices(
            current_settings.osrm_url,
            request.locations,
        )
        duration_matrix = validate_cost_matrix(
            raw_duration_matrix,
            request.locations,
            "duration",
        )
        distance_matrix = validate_cost_matrix(
            raw_distance_matrix,
            request.locations,
            "distance",
        )
        optimization_matrix = (
            duration_matrix if request.optimize_for == "time" else distance_matrix
        )
        locked_blocks = build_locked_blocks(request.locations)
        block_optimization_matrix = build_block_cost_matrix(
            locked_blocks,
            optimization_matrix,
        )

        fixed_end_block_index = None
        if request.must_end_at_last:
            last_point_index = len(request.locations) - 1
            fixed_end_block_index = next(
                (
                    block_index
                    for block_index, block in enumerate(locked_blocks)
                    if last_point_index in block["indices"]
                ),
                None,
            )

        optimal_block_indices = (
            [0]
            if len(locked_blocks) == 1
            else solve_tsp_open(block_optimization_matrix, fixed_end_block_index)
        )
        if not optimal_block_indices:
            raise HTTPException(
                status_code=500,
                detail="Could not find a mathematical solution.",
            )

        optimal_indices = expand_block_route(optimal_block_indices, locked_blocks)
        metrics = calculate_route_metrics(optimal_indices, duration_matrix, distance_matrix)

        snapped_lookup = {}
        for index, source in enumerate(snapped_sources):
            snapped_location = source.get("location") if isinstance(source, dict) else None
            if snapped_location and len(snapped_location) == 2:
                snapped_lookup[index] = {
                    "lat": snapped_location[1],
                    "lng": snapped_location[0],
                }

        ordered_locations = []
        ordered_points = []
        for index in optimal_indices:
            point = request.locations[index]
            ordered_points.append(point)
            ordered_locations.append({
                "id": point.id,
                "route_key": point.route_key or point.id,
                "lat": point.lat,
                "lng": point.lng,
                "snapped": snapped_lookup.get(index),
                "lock_group": normalize_lock_group(point.lock_group),
            })

        route_path = get_osrm_route_path(current_settings.osrm_url, ordered_points)

        return {
            "status": "success",
            "point_count": len(ordered_locations),
            "optimize_for": request.optimize_for,
            "must_end_at_last": request.must_end_at_last,
            "metrics": metrics,
            "optimized_route": ordered_locations,
            "road_geometry": route_path["geometry"],
            "road_legs": route_path["legs"],
        }
    except RouteValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpstreamRoutingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
