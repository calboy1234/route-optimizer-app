import os
import requests
import sys
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

class RouteRequest(BaseModel):
    locations: list[Point]

# --- Core Logic ---
def get_osrm_matrices(locations: list[Point]):
    """Fetch BOTH travel time and distance matrices from OSRM"""
    coords = ";".join([f"{loc.lng},{loc.lat}" for loc in locations])
    url = f"{OSRM_URL}/table/v1/driving/{coords}?annotations=duration,distance"
    
    response = requests.get(url, timeout=15)
    if response.status_code == 200:
        data = response.json()
        return data['durations'], data['distances']
    else:
        raise Exception(f"OSRM API Failed: {response.text}")

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

def solve_tsp_open(duration_matrix):
    """Solve the TSP as an Open Path (No return to start) using a Dummy Node"""
    num_real_nodes = len(duration_matrix)
    num_total_nodes = num_real_nodes + 1 # Add 1 dummy node
    
    # Expand matrix with the Dummy Node
    expanded_matrix = []
    for i in range(num_real_nodes):
        row = [int(x) for x in duration_matrix[i]]
        row.append(0) 
        expanded_matrix.append(row)
        
    expanded_matrix.append([0] * num_total_nodes)

    # Setup OR-Tools (Starts at 0, Ends at the Dummy Node)
    manager = pywrapcp.RoutingIndexManager(num_total_nodes, 1, [0], [num_real_nodes])
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
        duration_matrix, distance_matrix = get_osrm_matrices(request.locations)
        optimal_indices = solve_tsp_open(duration_matrix)
        
        if not optimal_indices:
            raise HTTPException(status_code=500, detail="Could not find a mathematical solution.")
            
        metrics = calculate_route_metrics(optimal_indices, duration_matrix, distance_matrix)
        ordered_locations = [request.locations[i] for i in optimal_indices]
        
        return {
            "status": "success",
            "point_count": len(ordered_locations),
            "metrics": metrics,
            "optimized_route": ordered_locations
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Server Runner ---
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)