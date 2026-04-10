#!/bin/bash
# Start Actual Budget server
# Pin version to match @actual-app/api in package.json (currently 26.4.0)

VERSION="26.4.0"
CONTAINER_NAME="actual_budget"
DATA_DIR="$(cd "$(dirname "$0")" && pwd)/data"

# Stop existing container if running
if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
  echo "Stopping existing $CONTAINER_NAME..."
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

# Remove stopped container if it exists
docker rm "$CONTAINER_NAME" 2>/dev/null

echo "Starting Actual Budget v${VERSION}..."
echo "Data directory: $DATA_DIR"

docker run \
  --restart=unless-stopped \
  -d \
  -p 5006:5006 \
  -v "$DATA_DIR:/data" \
  --name "$CONTAINER_NAME" \
  "actualbudget/actual-server:$VERSION"

echo "Actual Budget running at http://localhost:5006"
