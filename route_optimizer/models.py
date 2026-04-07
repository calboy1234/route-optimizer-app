from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Point(BaseModel):
    id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    lock_group: str | None = None


class RouteRequest(BaseModel):
    locations: list[Point]
    optimize_for: Literal["time", "distance"] = "time"
    must_end_at_last: bool = False

