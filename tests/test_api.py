from importlib import reload

from fastapi.testclient import TestClient

import route_optimizer.api as api_module
import route_optimizer.config as config_module


def get_test_client(monkeypatch, osrm_url=None):
    if osrm_url is None:
        monkeypatch.delenv("OSRM_URL", raising=False)
    else:
        monkeypatch.setenv("OSRM_URL", osrm_url)

    config_module.get_settings.cache_clear()
    reload(api_module)
    return TestClient(api_module.app)


def test_health_reports_degraded_without_osrm(monkeypatch):
    client = get_test_client(monkeypatch)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "degraded",
        "osrm_configured": False,
    }


def test_optimize_requires_osrm_configuration(monkeypatch):
    client = get_test_client(monkeypatch)

    response = client.post(
        "/api/optimize",
        json={
            "locations": [
                {"id": "A", "lat": 49.0, "lng": -97.0},
                {"id": "B", "lat": 49.1, "lng": -97.1},
            ]
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "OSRM_URL is not configured on the server."


def test_optimize_returns_validation_error_for_unreachable_points(monkeypatch):
    client = get_test_client(monkeypatch, osrm_url="http://osrm.test")

    def fake_get_osrm_matrices(osrm_url, locations):
        return [[0, None], [None, 0]], [[0, None], [None, 0]], []

    monkeypatch.setattr(api_module, "get_osrm_matrices", fake_get_osrm_matrices)

    response = client.post(
        "/api/optimize",
        json={
            "locations": [
                {"id": "A", "lat": 49.0, "lng": -97.0},
                {"id": "B", "lat": 49.1, "lng": -97.1},
            ]
        },
    )

    assert response.status_code == 400
    assert "cannot be routed together" in response.json()["detail"]


def test_optimize_returns_route_keys_and_road_legs(monkeypatch):
    client = get_test_client(monkeypatch, osrm_url="http://osrm.test")

    def fake_get_osrm_matrices(osrm_url, locations):
        return [[0, 60], [60, 0]], [[0, 1000], [1000, 0]], [{"location": [-97.0, 49.0]}, {"location": [-97.1, 49.1]}]

    def fake_get_osrm_route_path(osrm_url, locations):
        return {
            "geometry": [
                {"lat": 49.0, "lng": -97.0},
                {"lat": 49.05, "lng": -97.05},
                {"lat": 49.1, "lng": -97.1},
            ],
            "legs": [[
                {"lat": 49.0, "lng": -97.0},
                {"lat": 49.05, "lng": -97.05},
                {"lat": 49.1, "lng": -97.1},
            ]],
        }

    monkeypatch.setattr(api_module, "get_osrm_matrices", fake_get_osrm_matrices)
    monkeypatch.setattr(api_module, "get_osrm_route_path", fake_get_osrm_route_path)

    response = client.post(
        "/api/optimize",
        json={
            "locations": [
                {"id": "Start", "route_key": "point-1", "lat": 49.0, "lng": -97.0},
                {"id": "Finish", "route_key": "point-2", "lat": 49.1, "lng": -97.1},
            ]
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["optimized_route"][0]["id"] == "Start"
    assert payload["optimized_route"][0]["route_key"] == "point-1"
    assert payload["road_legs"] == fake_get_osrm_route_path(None, None)["legs"]


def test_export_map_returns_502_when_tiles_fail(monkeypatch):
    client = get_test_client(monkeypatch)

    def fake_fetch_tile(args):
        raise api_module.MapTileFetchError("Tile provider unavailable.")

    monkeypatch.setattr(api_module, "_fetch_tile", fake_fetch_tile)

    response = client.post(
        "/api/export-map",
        json={
            "bounds": {
                "north": 49.9,
                "south": 49.8,
                "east": -97.0,
                "west": -97.2,
            },
            "width": 512,
            "height": 256,
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Tile provider unavailable."
