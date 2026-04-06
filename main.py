import os
import requests

# This looks for a variable called OSRM_URL.
OSRM_URL = os.getenv("OSRM_URL")

def test_osrm():
    coords = "-97.1384,49.8951;-97.1500,49.9000"
    url = f"{OSRM_URL}/route/v1/driving/{coords}?overview=false"
    
    try:
        response = requests.get(url)
        data = response.json()
        
        if data['code'] == 'Ok':
            distance = data['routes'][0]['distance']
            duration = data['routes'][0]['duration']
            print(f"✅ Connection Successful!")
            print(f"Driving Distance: {distance} meters")
            print(f"Driving Time: {duration / 60:.2f} minutes")
        else:
            print(f"❌ OSRM returned an error: {data['code']}")
            
    except Exception as e:
        print(f"❌ Failed to connect to OSRM: {e}")

if __name__ == "__main__":
    test_osrm()