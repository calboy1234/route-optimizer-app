from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from route_optimizer.config import INDEX_HTML_PATH, get_settings
from route_optimizer.models import RouteRequest
from route_optimizer.solver import (
    RouteValidationError,
    UpstreamRoutingError,
    build_block_cost_matrix,
    build_locked_blocks,
    calculate_route_metrics,
    expand_block_route,
    get_osrm_matrices,
    get_osrm_route_geometry,
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
                "lat": point.lat,
                "lng": point.lng,
                "snapped": snapped_lookup.get(index),
                "lock_group": normalize_lock_group(point.lock_group),
            })

        road_geometry = get_osrm_route_geometry(current_settings.osrm_url, ordered_points)

        return {
            "status": "success",
            "point_count": len(ordered_locations),
            "optimize_for": request.optimize_for,
            "must_end_at_last": request.must_end_at_last,
            "metrics": metrics,
            "optimized_route": ordered_locations,
            "road_geometry": road_geometry,
        }
    except RouteValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UpstreamRoutingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

