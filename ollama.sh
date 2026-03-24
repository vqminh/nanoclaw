#!/bin/bash

# Check if ollama command is available
if ! command -v ollama &> /dev/null; then
    echo "Error: ollama command not found. Please ensure Ollama is installed."
    exit 1
fi

if [ -n "$1" ]; then
    model=$1
    echo "Using provided model: $model"
else
    echo "Fetching available Ollama models..."

    # Run 'ollama list', skip the header row, and extract the first column (model names)
    models_list=$(ollama list | awk 'NR>1 {print $1}')

    # Check if the list is empty
    if [ -z "$models_list" ]; then
        echo "No models found. Have you pulled any models with 'ollama pull'?"
        exit 1
    fi

    echo ""
    echo "Please select a model from the list below:"

    select model in $models_list; do
        if [ -n "$model" ]; then
            echo ""
            echo "✅ You successfully selected: $model"
            break
        else
            echo "Invalid selection. Please enter a valid number from the list."
        fi
    done
fi
CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_ENABLE_TELEMETRY=0 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_BASE_URL=http://localhost:11434 claude --model $model
