from route_optimizer.models import Point
from route_optimizer.solver import (
    RouteValidationError,
    build_locked_blocks,
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

