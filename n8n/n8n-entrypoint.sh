#!/bin/sh
set -e

mkdir -p /data/n8n && chmod -R 777 /data/n8n

# Auto-import workflow on first boot (only once)
if [ ! -f /data/n8n/.workflow_imported_v2 ]; then
  echo "[n8n-entrypoint] First boot detected. Importing workflow..."
  
  # Start n8n temporarily in the background to initialize the database
  n8n start &
  N8N_PID=$!
  
  # Wait for n8n to be ready (max 60 seconds)
  echo "[n8n-entrypoint] Waiting for n8n to initialize..."
  for i in $(seq 1 60); do
    if wget -q -O /dev/null http://localhost:5678/healthz 2>/dev/null; then
      echo "[n8n-entrypoint] n8n is ready!"
      break
    fi
    sleep 1
  done
  
  # Import the workflow
  echo "[n8n-entrypoint] Importing workflow from /app/workflow.json..."
  n8n import:workflow --input=/app/workflow.json 2>&1 || echo "[n8n-entrypoint] Import failed, will retry on next boot"
  
  # Activate the workflow via internal API
  echo "[n8n-entrypoint] Activating workflow..."
  # Get workflow ID and activate it
  WORKFLOW_ID=$(wget -q -O - http://localhost:5678/api/v1/workflows 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
  if [ -n "$WORKFLOW_ID" ]; then
    wget -q -O /dev/null --post-data='' "http://localhost:5678/api/v1/workflows/${WORKFLOW_ID}/activate" 2>/dev/null || true
    echo "[n8n-entrypoint] Workflow ${WORKFLOW_ID} activated!"
  fi
  
  # Mark as imported
  touch /data/n8n/.workflow_imported_v2
  echo "[n8n-entrypoint] Workflow import complete!"
  
  # Stop the temporary n8n
  kill $N8N_PID 2>/dev/null || true
  wait $N8N_PID 2>/dev/null || true
  sleep 2
fi

echo "[n8n-entrypoint] Starting n8n..."
exec n8n start
