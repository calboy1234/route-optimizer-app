import os
import requests
import sys
from typing import Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

# --- Initialization & Safety Checks ---
osrm_env = os.getenv("OSRM_URL", "").strip()
if not osrm_env:
    print("❌ ERROR: OSRM_URL environment variable is missing or empty!")
    sys.exit(1)

OSRM_URL = f"http://{osrm_env}" if not osrm_env.startswith("http") else osrm_env

app = FastAPI(title="Route Optimizer API")

# --- Security: CORS Middleware ---
# This allows your frontend (the browser) to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Data Models ---
class Point(BaseModel):
    id: str
    lat: float
    lng: float
    lock_group: str | None = None

class RouteRequest(BaseModel):
    locations: list[Point]
    optimize_for: Literal["time", "distance"] = "time"
    must_end_at_last: bool = False

# --- Core Logic ---
def get_osrm_matrices(locations: list[Point]):
    """Fetch travel matrices plus the snapped road coordinates OSRM uses."""
    coords = ";".join([f"{loc.lng},{loc.lat}" for loc in locations])
    url = f"{OSRM_URL}/table/v1/driving/{coords}?annotations=duration,distance"
    
    response = requests.get(url, timeout=15)
    if response.status_code == 200:
        data = response.json()
        return data['durations'], data['distances'], data.get('sources', [])
    else:
        raise Exception(f"OSRM API Failed: {response.text}")

def get_osrm_route_geometry(locations: list[Point]):
    """Fetch the actual drivable path for the ordered waypoints."""
    coords = ";".join([f"{loc.lng},{loc.lat}" for loc in locations])
    url = f"{OSRM_URL}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=false"

    response = requests.get(url, timeout=15)
    if response.status_code != 200:
        raise Exception(f"OSRM Route API Failed: {response.text}")

    data = response.json()
    routes = data.get("routes", [])
    if not routes:
        raise Exception("OSRM Route API returned no drivable path.")

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
    """Isolated function to calculate the total time and distance."""
    total_duration = 0.0
    total_distance = 0.0
    
    for i in range(len(route_indices) - 1):
        from_node = route_indices[i]
        to_node = route_indices[i+1]
        
        total_duration += duration_matrix[from_node][to_node]
        total_distance += distance_matrix[from_node][to_node]
        
    return {
        "duration_seconds": total_duration,
        "distance_meters": total_distance,
        "duration_minutes": round(total_duration / 60, 2),
        "distance_km": round(total_distance / 1000, 2)
    }

def normalize_lock_group(lock_group: str | None) -> str | None:
    if lock_group is None:
        return None

    cleaned = str(lock_group).strip()
    return cleaned or None

def build_locked_blocks(locations: list[Point]):
    grouped_blocks: dict[str, dict] = {}
    blocks: list[dict] = []

    for index, point in enumerate(locations):
        lock_group = normalize_lock_group(point.lock_group)
        if lock_group:
            if lock_group not in grouped_blocks:
                grouped_blocks[lock_group] = {
                    "label": lock_group,
                    "indices": [],
                    "first_index": index
                }
                blocks.append(grouped_blocks[lock_group])
            grouped_blocks[lock_group]["indices"].append(index)
            continue

        blocks.append({
            "label": None,
            "indices": [index],
            "first_index": index
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

def solve_tsp_open(cost_matrix, fixed_end_node: int | None = None):
    """Solve the TSP as an Open Path (No return to start) using a Dummy Node"""
    num_real_nodes = len(cost_matrix)
    use_dummy_end = fixed_end_node is None
    num_total_nodes = num_real_nodes + 1 if use_dummy_end else num_real_nodes

    expanded_matrix = []
    for i in range(num_real_nodes):
        row = [int(x) for x in cost_matrix[i]]
        if use_dummy_end:
            row.append(0)
        expanded_matrix.append(row)

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
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)

    solution = routing.SolveWithParameters(search_parameters)

    # Extract the route
    if solution:
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
    return None

# --- Web Endpoints ---

# 1. The UI Route (Serves the HTML Dashboard)
@app.get("/", response_class=FileResponse)
def serve_ui():
    """Serves the index.html file to the browser"""
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"error": "UI file not found. Please ensure index.html is in the container root."}

# 2. Health Check
@app.get("/health")
def health_check():
    return {"status": "online", "osrm_url": OSRM_URL}

# 3. The Core API Engine
@app.post("/api/optimize")
def optimize_route(request: RouteRequest):
    if len(request.locations) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 points to route.")
        
    try:
        duration_matrix, distance_matrix, snapped_sources = get_osrm_matrices(request.locations)
        optimization_matrix = duration_matrix if request.optimize_for == "time" else distance_matrix
        locked_blocks = build_locked_blocks(request.locations)
        block_optimization_matrix = build_block_cost_matrix(locked_blocks, optimization_matrix)
        fixed_end_block_index = None
        if request.must_end_at_last:
            last_point_index = len(request.locations) - 1
            fixed_end_block_index = next(
                (
                    block_index
                    for block_index, block in enumerate(locked_blocks)
                    if last_point_index in block["indices"]
                ),
                None
            )

        optimal_block_indices = [0] if len(locked_blocks) == 1 else solve_tsp_open(block_optimization_matrix, fixed_end_block_index)
        
        if not optimal_block_indices:
            raise HTTPException(status_code=500, detail="Could not find a mathematical solution.")

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
                "lock_group": normalize_lock_group(point.lock_group)
            })
        road_geometry = get_osrm_route_geometry(ordered_points)
        
        return {
            "status": "success",
            "point_count": len(ordered_locations),
            "optimize_for": request.optimize_for,
            "must_end_at_last": request.must_end_at_last,
            "metrics": metrics,
            "optimized_route": ordered_locations,
            "road_geometry": road_geometry
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Server Runner ---
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
