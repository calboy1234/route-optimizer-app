from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML_PATH = PROJECT_ROOT / "index.html"


@dataclass(frozen=True)
class Settings:
    osrm_url: str | None
    allowed_origins: tuple[str, ...]

    @property
    def is_osrm_configured(self) -> bool:
        return bool(self.osrm_url)

    @property
    def allow_credentials(self) -> bool:
        return bool(self.allowed_origins) and "*" not in self.allowed_origins


def normalize_osrm_url(value: str) -> str:
    cleaned = value.strip().rstrip("/")
    if not cleaned:
        raise ValueError("OSRM_URL cannot be empty.")

    return cleaned if cleaned.startswith(("http://", "https://")) else f"http://{cleaned}"


def parse_allowed_origins(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()

    origins = [origin.strip() for origin in value.split(",")]
    return tuple(origin for origin in origins if origin)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    osrm_value = os.getenv("OSRM_URL", "")
    osrm_url = normalize_osrm_url(osrm_value) if osrm_value.strip() else None
    allowed_origins = parse_allowed_origins(os.getenv("ROUTE_OPTIMIZER_ALLOWED_ORIGINS"))
    return Settings(osrm_url=osrm_url, allowed_origins=allowed_origins)

