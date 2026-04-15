from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Point(BaseModel):
    id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    route_key: str | None = None
    lock_group: str | None = None


class RouteRequest(BaseModel):
    locations: list[Point]
    optimize_for: Literal["time", "distance"] = "time"
    must_end_at_last: bool = False


# ── Map Export Models ──────────────────────────────────────────────────────────

class ExportBounds(BaseModel):
    north: float = Field(ge=-90, le=90)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    west: float = Field(ge=-180, le=180)


class ExportRoutePoint(BaseModel):
    lat: float
    lng: float


class ExportRouteSegment(BaseModel):
    color: str
    geometry: list[ExportRoutePoint] = Field(default_factory=list)


class ExportWaypoint(BaseModel):
    lat: float
    lng: float
    routeKey: str = ""
    id: str = ""
    rank: int | None = None


class MapExportRequest(BaseModel):
    bounds: ExportBounds
    width: int = Field(ge=256, le=8192, default=2048)
    height: int = Field(ge=256, le=8192, default=2048)
    format: Literal["png", "jpeg"] = "png"
    map_style: Literal["light", "dark", "voyager", "streets"] = "voyager"
    # Route
    show_route: bool = True
    route_style: Literal["solid", "gradient"] = "solid"
    route_color: str = "#2563eb"
    route_thickness: float = Field(ge=1.0, le=20.0, default=4.0)
    route_opacity: float = Field(ge=0.0, le=1.0, default=0.85)
    route_dashed: bool = False
    route_geometry: list[ExportRoutePoint] = Field(default_factory=list)
    route_segments: list[ExportRouteSegment] = Field(default_factory=list)
    # Points
    show_points: bool = True
    show_point_labels: bool = True
    point_color: str = "#2563eb"
    point_size: float = Field(ge=2.0, le=40.0, default=9.0)
    point_shape: Literal["circle", "pin"] = "circle"
    point_visibility: Literal["all", "start_end", "none"] = "all"
    waypoints: list[ExportWaypoint] = Field(default_factory=list)
