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
