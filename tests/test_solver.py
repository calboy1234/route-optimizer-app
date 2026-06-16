from urllib.parse import parse_qs, urlparse

from route_optimizer.models import Point
from route_optimizer.solver import (
    RouteValidationError,
    build_locked_blocks,
    get_osrm_matrices,
    get_osrm_route_path,
    solve_tsp_open,
    validate_cost_matrix,
)


def test_build_locked_blocks_keeps_grouped_points_together():
    points = [
        Point(id="Start", lat=0, lng=0),
        Point(id="A1", lat=1, lng=1, lock_group="alpha"),
        Point(id="Solo", lat=2, lng=2),
        Point(id="A2", lat=3, lng=3, lock_group="alpha"),
    ]

    blocks = build_locked_blocks(points)

    assert [block["indices"] for block in blocks] == [[0], [1, 3], [2]]


def test_solve_tsp_open_respects_fixed_end_node():
    matrix = [
        [0, 2, 9, 9],
        [2, 0, 2, 9],
        [9, 2, 0, 2],
        [9, 9, 2, 0],
    ]

    route = solve_tsp_open(matrix, fixed_end_node=3)

    assert route is not None
    assert route[0] == 0
    assert route[-1] == 3


def test_validate_cost_matrix_rejects_unreachable_pairs():
    points = [
        Point(id="A", lat=0, lng=0),
        Point(id="B", lat=1, lng=1),
    ]

    matrix = [
        [0, None],
        [1, 0],
    ]

    try:
        validate_cost_matrix(matrix, points, "duration")
    except RouteValidationError as exc:
        assert "A -> B" in str(exc)
    else:
        raise AssertionError("Expected RouteValidationError for unreachable waypoints")


def test_get_osrm_matrices_tiles_requests_over_default_table_limit(monkeypatch):
    points = [
        Point(id=str(index), lat=49.0 + index * 0.001, lng=-97.0 - index * 0.001)
        for index in range(104)
    ]
    request_coordinate_counts = []

    def point_index_from_coordinate(coord):
        _, lat = [float(value) for value in coord.split(",")]
        return round((lat - 49.0) / 0.001)

    def fake_fetch_osrm_json(url):
        parsed = urlparse(url)
        coords = url.split("/driving/", 1)[1].split("?", 1)[0].split(";")
        query = parse_qs(parsed.query)
        sources = [int(value) for value in query["sources"][0].split(";")]
        destinations = [int(value) for value in query["destinations"][0].split(";")]
        request_coordinate_counts.append(len(coords))

        source_point_indexes = [
            point_index_from_coordinate(coords[index]) for index in sources
        ]
        destination_point_indexes = [
            point_index_from_coordinate(coords[index]) for index in destinations
        ]
        return {
            "code": "Ok",
            "durations": [
                [
                    source_index * 1000 + destination_index
                    for destination_index in destination_point_indexes
                ]
                for source_index in source_point_indexes
            ],
            "distances": [
                [
                    source_index * 10000 + destination_index
                    for destination_index in destination_point_indexes
                ]
                for source_index in source_point_indexes
            ],
            "sources": [
                {"location": [points[source_index].lng, points[source_index].lat]}
                for source_index in source_point_indexes
            ],
        }

    monkeypatch.setattr("route_optimizer.solver.fetch_osrm_json", fake_fetch_osrm_json)

    durations, distances, snapped_sources = get_osrm_matrices("http://osrm.test", points)

    assert len(request_coordinate_counts) == 9
    assert max(request_coordinate_counts) <= 100
    assert durations[0][103] == 103
    assert durations[103][0] == 103000
    assert distances[57][78] == 570078
    assert snapped_sources[103]["location"] == [points[103].lng, points[103].lat]


def test_get_osrm_route_path_merges_leg_step_geometry(monkeypatch):
    def fake_fetch_osrm_json(url):
        return {
            "code": "Ok",
            "routes": [{
                "geometry": {
                    "coordinates": [[-97.0, 49.0], [-97.05, 49.05], [-97.1, 49.1]],
                },
                "legs": [
                    {
                        "steps": [
                            {"geometry": {"coordinates": [[-97.0, 49.0], [-97.02, 49.02]]}},
                            {"geometry": {"coordinates": [[-97.02, 49.02], [-97.05, 49.05]]}},
                        ]
                    },
                    {
                        "steps": [
                            {"geometry": {"coordinates": [[-97.05, 49.05], [-97.08, 49.08]]}},
                            {"geometry": {"coordinates": [[-97.08, 49.08], [-97.1, 49.1]]}},
                        ]
                    },
                ],
            }],
        }

    monkeypatch.setattr("route_optimizer.solver.fetch_osrm_json", fake_fetch_osrm_json)

    route = get_osrm_route_path(
        "http://osrm.test",
        [
            Point(id="A", lat=49.0, lng=-97.0),
            Point(id="B", lat=49.05, lng=-97.05),
            Point(id="C", lat=49.1, lng=-97.1),
        ],
    )

    assert route["geometry"] == [
        {"lat": 49.0, "lng": -97.0},
        {"lat": 49.05, "lng": -97.05},
        {"lat": 49.1, "lng": -97.1},
    ]
    assert route["legs"] == [
        [
            {"lat": 49.0, "lng": -97.0},
            {"lat": 49.02, "lng": -97.02},
            {"lat": 49.05, "lng": -97.05},
        ],
        [
            {"lat": 49.05, "lng": -97.05},
            {"lat": 49.08, "lng": -97.08},
            {"lat": 49.1, "lng": -97.1},
        ],
    ]
