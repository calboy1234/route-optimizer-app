FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# We will start by just running a test script
CMD ["python", "main.py"]

# Expose the API port
EXPOSE 8000

# Start the web server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]