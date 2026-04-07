from __future__ import annotations

from typing import Any

import requests
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from route_optimizer.models import Point


class RouteValidationError(ValueError):
    """Raised when request data cannot produce a valid route."""


class UpstreamRoutingError(RuntimeError):
    """Raised when OSRM returns an invalid or failed response."""


def fetch_osrm_json(url: str) -> dict[str, Any]:
    try:
        response = requests.get(url, timeout=15)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise UpstreamRoutingError(f"OSRM request failed: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise UpstreamRoutingError("OSRM returned invalid JSON.") from exc

    if data.get("code") not in (None, "Ok"):
        message = data.get("message") or data.get("code") or "Unknown OSRM error"
        raise UpstreamRoutingError(f"OSRM error: {message}")

    return data


def get_osrm_matrices(osrm_url: str, locations: list[Point]):
    """Fetch travel matrices plus the snapped road coordinates OSRM uses."""
    coords = ";".join(f"{loc.lng},{loc.lat}" for loc in locations)
    url = f"{osrm_url}/table/v1/driving/{coords}?annotations=duration,distance"
    data = fetch_osrm_json(url)
    return data.get("durations"), data.get("distances"), data.get("sources", [])


def get_osrm_route_geometry(osrm_url: str, locations: list[Point]):
    """Fetch the actual drivable path for the ordered waypoints."""
    coords = ";".join(f"{loc.lng},{loc.lat}" for loc in locations)
    url = (
        f"{osrm_url}/route/v1/driving/{coords}"
        "?overview=full&geometries=geojson&steps=false"
    )
    data = fetch_osrm_json(url)
    routes = data.get("routes", [])
    if not routes:
        raise UpstreamRoutingError("OSRM returned no drivable path.")

    geometry = routes[0].get("geometry", {})
    coordinates = geometry.get("coordinates", [])
    return [
        {
            "lat": coordinate[1],
            "lng": coordinate[0],
        }
        for coordinate in coordinates
        if isinstance(coordinate, list) and len(coordinate) == 2
    ]


def calculate_route_metrics(route_indices, duration_matrix, distance_matrix):
    """Calculate the total time and distance for an ordered route."""
    total_duration = 0.0
    total_distance = 0.0

    for index in range(len(route_indices) - 1):
        from_node = route_indices[index]
        to_node = route_indices[index + 1]

        total_duration += duration_matrix[from_node][to_node]
        total_distance += distance_matrix[from_node][to_node]

    return {
        "duration_seconds": total_duration,
        "distance_meters": total_distance,
        "duration_minutes": round(total_duration / 60, 2),
        "distance_km": round(total_distance / 1000, 2),
    }


def normalize_lock_group(lock_group: str | None) -> str | None:
    if lock_group is None:
        return None

    cleaned = str(lock_group).strip()
    return cleaned or None


def build_locked_blocks(locations: list[Point]):
    grouped_blocks: dict[str, dict[str, Any]] = {}
    blocks: list[dict[str, Any]] = []

    for index, point in enumerate(locations):
        lock_group = normalize_lock_group(point.lock_group)
        if lock_group:
            if lock_group not in grouped_blocks:
                grouped_blocks[lock_group] = {
                    "label": lock_group,
                    "indices": [],
                    "first_index": index,
                }
                blocks.append(grouped_blocks[lock_group])
            grouped_blocks[lock_group]["indices"].append(index)
            continue

        blocks.append({
            "label": None,
            "indices": [index],
            "first_index": index,
        })

    return sorted(blocks, key=lambda block: block["first_index"])


def build_block_cost_matrix(blocks, point_cost_matrix):
    block_cost_matrix = []
    for from_block_index, from_block in enumerate(blocks):
        row = []
        for to_block_index, to_block in enumerate(blocks):
            if from_block_index == to_block_index:
                row.append(0)
                continue

            from_point_index = from_block["indices"][-1]
            to_point_index = to_block["indices"][0]
            row.append(point_cost_matrix[from_point_index][to_point_index])
        block_cost_matrix.append(row)
    return block_cost_matrix


def expand_block_route(block_route_indices, blocks):
    expanded_route = []
    for block_index in block_route_indices:
        expanded_route.extend(blocks[block_index]["indices"])
    return expanded_route


def validate_cost_matrix(matrix, locations: list[Point], label: str):
    point_count = len(locations)
    if not isinstance(matrix, list) or len(matrix) != point_count:
        raise UpstreamRoutingError(f"OSRM returned an invalid {label} matrix.")

    unreachable_pairs: list[str] = []
    validated_matrix: list[list[float]] = []

    for row_index, row in enumerate(matrix):
        if not isinstance(row, list) or len(row) != point_count:
            raise UpstreamRoutingError(f"OSRM returned an invalid {label} matrix.")

        validated_row: list[float] = []
        for column_index, value in enumerate(row):
            if row_index == column_index:
                validated_row.append(0.0 if value is None else float(value))
                continue

            if value is None:
                if len(unreachable_pairs) < 5:
                    start_name = locations[row_index].id
                    end_name = locations[column_index].id
                    unreachable_pairs.append(f"{start_name} -> {end_name}")
                validated_row.append(float("inf"))
                continue

            numeric_value = float(value)
            if numeric_value < 0:
                raise UpstreamRoutingError(f"OSRM returned a negative {label} value.")
            validated_row.append(numeric_value)

        validated_matrix.append(validated_row)

    if unreachable_pairs:
        examples = ", ".join(unreachable_pairs)
        raise RouteValidationError(
            "Some waypoints cannot be routed together on the road network. "
            f"Examples: {examples}."
        )

    return validated_matrix


def solve_tsp_open(cost_matrix, fixed_end_node: int | None = None):
    """Solve the TSP as an open path without returning to the start."""
    num_real_nodes = len(cost_matrix)
    use_dummy_end = fixed_end_node is None
    num_total_nodes = num_real_nodes + 1 if use_dummy_end else num_real_nodes

    expanded_matrix = []
    for row in cost_matrix:
        expanded_row = [int(value) for value in row]
        if use_dummy_end:
            expanded_row.append(0)
        expanded_matrix.append(expanded_row)

    if use_dummy_end:
        expanded_matrix.append([0] * num_total_nodes)

    end_node = num_real_nodes if use_dummy_end else fixed_end_node
    manager = pywrapcp.RoutingIndexManager(num_total_nodes, 1, [0], [end_node])
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return expanded_matrix[from_node][to_node]

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )

    solution = routing.SolveWithParameters(search_parameters)
    if not solution:
        return None

    index = routing.Start(0)
    route_indices = []
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        if node < num_real_nodes:
            route_indices.append(node)
        index = solution.Value(routing.NextVar(index))

    if not use_dummy_end:
        end_index = routing.End(0)
        end_node = manager.IndexToNode(end_index)
        if end_node < num_real_nodes and (not route_indices or route_indices[-1] != end_node):
            route_indices.append(end_node)

    return route_indices

