# Kiro Steering Rules for Team Streamlit

## Overview
This file serves as the Kiro steering document. Kiro must abide by the rules defined here during all generations.

## Architecture Guardrails
1. **Single Port Policy (8080):** All frontend and backend services must run on port 8080 via `start_demo.py` to prevent CORS issues.
2. **Zero-Dependency Frontend:** The UI uses Vanilla JS and raw SVG. No Chart.js, React, or Vue is allowed.
3. **Encoding Safety:** All file operations in Python must explicitly use `encoding='utf-8'`.
4. **Bedrock RPS Constraint:** Amazon Bedrock calls are strictly capped at 1 RPS (Requests Per Second).

## Automation Hook Config
Hooks are disabled in this environment unless explicitly triggered via `.kiro/hooks/`.
