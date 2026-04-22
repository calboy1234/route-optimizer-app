import io
from importlib import reload

from fastapi.testclient import TestClient
from PIL import Image

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


def test_export_font_loader_returns_scalable_fonts():
    api_module._load_font.cache_clear()

    small_font = api_module._load_font(12, bold=True)
    large_font = api_module._load_font(36, bold=True)

    small_bbox = small_font.getbbox("Waypoint")
    large_bbox = large_font.getbbox("Waypoint")

    small_width = small_bbox[2] - small_bbox[0]
    small_height = small_bbox[3] - small_bbox[1]
    large_width = large_bbox[2] - large_bbox[0]
    large_height = large_bbox[3] - large_bbox[1]

    assert large_width > small_width
    assert large_height > small_height


def test_export_map_label_size_changes_rendered_output(monkeypatch):
    client = get_test_client(monkeypatch)

    base_payload = {
        "bounds": {
            "north": 49.91,
            "south": 49.89,
            "east": -97.09,
            "west": -97.11,
        },
        "width": 512,
        "height": 512,
        "format": "transparent",
        "show_route": False,
        "show_points": True,
        "show_point_labels": True,
        "point_size": 8,
        "waypoints": [
            {
                "lat": 49.9,
                "lng": -97.1,
                "id": "Waypoint Label",
            }
        ],
    }

    small_response = client.post("/api/export-map", json={**base_payload, "label_size": 10})
    large_response = client.post("/api/export-map", json={**base_payload, "label_size": 32})

    assert small_response.status_code == 200
    assert large_response.status_code == 200

    small_bbox = Image.open(io.BytesIO(small_response.content)).getbbox()
    large_bbox = Image.open(io.BytesIO(large_response.content)).getbbox()

    assert small_bbox is not None
    assert large_bbox is not None
    assert (large_bbox[2] - large_bbox[0]) > (small_bbox[2] - small_bbox[0])
    assert (large_bbox[3] - large_bbox[1]) >= (small_bbox[3] - small_bbox[1])


def _route_export_payload():
    return {
        "bounds": {
            "north": 49.94,
            "south": 49.86,
            "east": -97.04,
            "west": -97.16,
        },
        "width": 512,
        "height": 512,
        "format": "transparent",
        "show_route": True,
        "show_points": False,
        "route_color": "#2563eb",
        "route_geometry": [
            {"lat": 49.87, "lng": -97.15},
            {"lat": 49.89, "lng": -97.12},
            {"lat": 49.91, "lng": -97.09},
            {"lat": 49.93, "lng": -97.06},
        ],
    }


def test_export_map_direction_modes_render_output(monkeypatch):
    client = get_test_client(monkeypatch)

    for mode in ["arrows", "chevrons", "dashed_arrows", "dots"]:
        response = client.post(
            "/api/export-map",
            json={
                **_route_export_payload(),
                "direction_mode": mode,
                "direction_color": "#ffffff",
                "direction_density": 65,
                "direction_size": 18,
            },
        )

        assert response.status_code == 200
        assert len(response.content) > 0
        assert Image.open(io.BytesIO(response.content)).getbbox() is not None


def test_export_map_direction_density_changes_rendered_output(monkeypatch):
    client = get_test_client(monkeypatch)
    base_payload = {
        **_route_export_payload(),
        "direction_mode": "arrows",
        "direction_color": "#ffffff",
        "direction_size": 18,
    }

    sparse_response = client.post("/api/export-map", json={**base_payload, "direction_density": 15})
    dense_response = client.post("/api/export-map", json={**base_payload, "direction_density": 90})

    assert sparse_response.status_code == 200
    assert dense_response.status_code == 200
    assert sparse_response.content != dense_response.content


def test_export_map_label_text_color_changes_rendered_output(monkeypatch):
    client = get_test_client(monkeypatch)
    base_payload = {
        "bounds": {
            "north": 49.91,
            "south": 49.89,
            "east": -97.09,
            "west": -97.11,
        },
        "width": 512,
        "height": 512,
        "format": "transparent",
        "show_route": False,
        "show_points": True,
        "show_point_labels": True,
        "point_size": 8,
        "label_bg_enabled": False,
        "waypoints": [
            {
                "lat": 49.9,
                "lng": -97.1,
                "id": "Waypoint Label",
            }
        ],
    }

    dark_response = client.post("/api/export-map", json={**base_payload, "label_text_color": "#000000"})
    red_response = client.post("/api/export-map", json={**base_payload, "label_text_color": "#ff0000"})

    assert dark_response.status_code == 200
    assert red_response.status_code == 200
    assert dark_response.content != red_response.content


def test_export_map_label_background_toggle_changes_rendered_output(monkeypatch):
    client = get_test_client(monkeypatch)
    base_payload = {
        "bounds": {
            "north": 49.91,
            "south": 49.89,
            "east": -97.09,
            "west": -97.11,
        },
        "width": 512,
        "height": 512,
        "format": "transparent",
        "show_route": False,
        "show_points": True,
        "show_point_labels": True,
        "point_size": 8,
        "label_text_color": "#000000",
        "label_bg_color": "#ffffff",
        "label_bg_padding": 10,
        "waypoints": [
            {
                "lat": 49.9,
                "lng": -97.1,
                "id": "Waypoint Label",
            }
        ],
    }

    bg_on_response = client.post("/api/export-map", json={**base_payload, "label_bg_enabled": True})
    bg_off_response = client.post("/api/export-map", json={**base_payload, "label_bg_enabled": False})

    assert bg_on_response.status_code == 200
    assert bg_off_response.status_code == 200
    assert bg_on_response.content != bg_off_response.content
