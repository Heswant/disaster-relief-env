---
title: Disaster Relief Supply Agent
emoji: 🆘
colorFrom: red
colorTo: orange
sdk: docker
app_port: 7860
tags:
  - openenv
  - reinforcement-learning
  - disaster-response
  - humanitarian-ai
  - meta-pytorch-hackathon
---

# Disaster Relief Supply Agent

An **OpenEnv-compatible RL environment** where an AI agent controls a supply truck
distributing food, medicine, and water to disaster victims across a 10×10 zone —
under resource constraints, blocked roads, and time-sensitive health deterioration.

Built for the **Meta PyTorch OpenEnv Hackathon 2026**.

---

## Real-World Task

This environment simulates **humanitarian disaster response logistics** — a genuine
operational challenge faced by organisations like FEMA, UNICEF, and Red Cross.
The agent must plan efficient delivery routes while:

- Managing limited truck inventory (must return to depots to restock)
- Navigating blocked roads (flood water / collapsed buildings)
- Prioritising CRITICAL victims whose health worsens every step
- Completing the mission before time runs out

---

## 3 Tasks — Easy → Medium → Hard

| Task ID | Scenario | Difficulty | Max Steps | Victims | Blocked Zones |
|---|---|---|---|---|---|
| `easy` | Humanitarian Aid Distribution Center | Easy | 70 | 460 | None |
| `medium` | River Delta Flood — Day 1 Response | Medium | 50 | 1,435 | 14 zones |
| `hard` | Urban Earthquake — 6 Hours Post-Event | Hard | 60 | 1,760 | 10 zones |

All tasks share the same API. Switch via `SCENARIO` env var or use `/tasks` to list all.

---

## Quick Start

```bash
# 1. Clone and enter the project
cd hackthon_new

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Verify baseline scores (all 3 tasks)
python baseline.py

# 5. Start the server
uvicorn app:app --host 0.0.0.0 --port 7860 --reload
```

Server runs at `http://localhost:7860`
Auto-generated API docs at `http://localhost:7860/docs`

---

## API Endpoints

### Standard OpenEnv Endpoints

#### `POST /reset`
Start a new episode. Returns the initial `ReliefObservation`.

```bash
curl -X POST http://localhost:7860/reset
```

#### `POST /step`
Execute one action. Returns `(observation, reward, done, info)`.

```bash
# Move the truck north
curl -X POST http://localhost:7860/step \
  -H "Content-Type: application/json" \
  -d '{"action_type": "move", "direction": "north"}'

# Deliver 50 units of food to zone Z_3_3
curl -X POST http://localhost:7860/step \
  -H "Content-Type: application/json" \
  -d '{"action_type": "deliver", "target_zone_id": "Z_3_3", "supply_type": "food", "quantity": 50}'

# Restock at current depot
curl -X POST http://localhost:7860/step \
  -H "Content-Type: application/json" \
  -d '{"action_type": "restock"}'
```

#### `GET /state`
Get current episode metadata (episode ID, step count, total reward, coverage).

```bash
curl http://localhost:7860/state
```

#### `GET /health`
Health check — returns HTTP 200 when the server is running.

```bash
curl http://localhost:7860/health
```

---

### Hackathon Required Endpoints

#### `GET /tasks`
Returns all 3 tasks with difficulty levels and the full action schema.

```bash
curl http://localhost:7860/tasks
```

Response:
```json
{
  "tasks": [
    {"task_id": "easy",   "scenario": "relief_camp",  "difficulty": "easy",   "max_steps": 70},
    {"task_id": "medium", "scenario": "flood",         "difficulty": "medium", "max_steps": 50},
    {"task_id": "hard",   "scenario": "earthquake",    "difficulty": "hard",   "max_steps": 60}
  ],
  "action_schema": { ... },
  "total_tasks": 3
}
```

#### `GET /grader`
Returns the normalized score (0.0–1.0) for the current episode.
Score = 80% coverage + 20% speed efficiency.

```bash
curl http://localhost:7860/grader
```

Response:
```json
{
  "score": 0.74,
  "coverage_percent": 88.5,
  "victims_saved": 980,
  "steps_used": 38,
  "is_complete": false,
  "mission_success": false,
  "breakdown": {"coverage_component": 0.708, "speed_component": 0.033}
}
```

#### `GET /baseline`
Runs the greedy agent on all 3 tasks and returns reproducible baseline scores.

```bash
curl http://localhost:7860/baseline
```

Response:
```json
{
  "baseline_scores": {
    "easy":   {"score": 0.87, "difficulty": "easy"},
    "medium": {"score": 0.65, "difficulty": "medium"},
    "hard":   {"score": 0.52, "difficulty": "hard"}
  },
  "policy": "greedy — nearest critical zone first",
  "seed": 42
}
```

---

## Action Space

| Field | Type | Required | Values / Range |
|---|---|---|---|
| `action_type` | string | Always | `deliver` / `move` / `restock` / `wait` |
| `direction` | string | For `move` | `north` / `south` / `east` / `west` |
| `target_zone_id` | string | For `deliver` | e.g. `"Z_3_4"` |
| `supply_type` | string | For `deliver` | `food` / `medicine` / `water` / `rescue_team` |
| `quantity` | integer | For `deliver` | 1 – 100 |

**Action descriptions:**

| Action | Description |
|---|---|
| `DELIVER` | Deliver supplies to a victim zone. Truck must be at that zone. |
| `MOVE` | Move truck one cell in given direction. Blocked zones cannot be entered. |
| `RESTOCK` | Refill truck inventory. Truck must be at a depot zone. |
| `WAIT` | Skip turn. Incurs a small penalty. |

---

## Observation Space

Every call to `reset()` or `step()` returns a `ReliefObservation` with these fields:

### Context
| Field | Type | Description |
|---|---|---|
| `disaster_type` | string | `flood` or `earthquake` |
| `scenario_name` | string | Human-readable scenario name |
| `step_number` | int | Current step (0 = just reset) |
| `max_steps` | int | Episode time limit |
| `time_elapsed_hours` | float | Simulated time (0.5h per step) |

### Map State
| Field | Type | Description |
|---|---|---|
| `grid_size` | int | Always 10 (10×10 grid = 100 zones) |
| `zones` | list[ZoneInfo] | Full state of all 100 zones |
| `critical_zones` | list[str] | Zone IDs currently at CRITICAL need level |
| `accessible_depots` | list[str] | Zone IDs of reachable depot zones |

**ZoneInfo fields:**

| Field | Type | Description |
|---|---|---|
| `zone_id` | string | Unique ID e.g. `"Z_3_4"` (col_row) |
| `x`, `y` | int | Grid coordinates (0–9) |
| `zone_type` | string | `victim` / `depot` / `blocked` / `empty` |
| `victim_count` | int | Number of people in this zone |
| `need_level` | string | `critical` / `high` / `moderate` / `low` / `none` |
| `needs` | dict | Required supply quantities e.g. `{"food": 50, "water": 80}` |
| `supplied` | dict | Already delivered quantities |
| `is_accessible` | bool | False if road is blocked |

### Truck Status
| Field | Type | Description |
|---|---|---|
| `truck.current_zone_id` | string | Zone the truck is currently in |
| `truck.x`, `truck.y` | int | Truck grid coordinates |
| `truck.inventory` | dict | Current supplies on truck |
| `truck.capacity_remaining` | int | Remaining carrying capacity |

### Mission Metrics
| Field | Type | Description |
|---|---|---|
| `total_victims` | int | Total victim count across all zones |
| `victims_served` | int | Victims in fully-served zones |
| `victims_critical_unserved` | int | Victims in CRITICAL zones with no aid |
| `supplies_delivered` | dict | Cumulative supplies delivered this episode |
| `coverage_percent` | float | % of victim zones fully served (0–100) |

### Feedback
| Field | Type | Description |
|---|---|---|
| `last_action_result` | string | Human-readable result of the last action |
| `last_reward` | float | Reward earned on the last step |
| `is_complete` | bool | True if episode has ended |
| `mission_success` | bool | True if 90%+ coverage achieved |

---

## Reward Function

Step rewards (partial progress signals):

| Event | Reward |
|---|---|
| Deliver to CRITICAL zone (full) | **+1.00** |
| Deliver to HIGH zone (full) | **+0.70** |
| Deliver to MODERATE zone (full) | **+0.40** |
| Deliver to LOW zone (full) | **+0.20** |
| Partial delivery | Proportionally scaled |
| CRITICAL zone unserved each step | **−0.11 to −0.61** (grows over time) |
| WAIT action | **−0.10** |
| Invalid action | **−0.05** |

Terminal rewards (episode end):

| Event | Reward |
|---|---|
| Coverage bonus | **+0.0 to +5.0** (proportional to coverage %) |
| Speed bonus | **+0.0 to +2.0** (finishing early) |
| Perfect 100% coverage jackpot | **+10.0** |

Grader score (0.0–1.0): `0.8 × coverage + 0.2 × speed_efficiency`

---

## Project Structure

```
hackthon_new/
├── disaster_relief_env/
│   ├── __init__.py        ← Package exports
│   ├── models.py          ← Pydantic types: Action, Observation, State, ZoneInfo
│   ├── grid.py            ← 10×10 map engine: zones, movement, delivery, time advance
│   ├── environment.py     ← OpenEnv Environment: reset() / step() / state()
│   ├── grader.py          ← Reward computation: step rewards + terminal bonus
│   ├── scenarios.py       ← 3 scenario definitions: relief_camp, flood, earthquake
│   └── server.py          ← FastAPI app: OpenEnv + /tasks /grader /baseline
├── app.py                 ← HuggingFace Spaces entry point
├── baseline.py            ← Standalone greedy agent inference script
├── openenv.yaml           ← OpenEnv manifest
├── Dockerfile             ← Container image (port 7860)
├── requirements.txt       ← Python dependencies
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SCENARIO` | `flood` | Active scenario: `relief_camp` / `flood` / `earthquake` |
| `RNG_SEED` | `42` | Random seed for reproducibility |

---

## Docker

```bash
# Build
docker build -t disaster-relief-env:latest .

# Run (flood scenario)
docker run -p 7860:7860 -e SCENARIO=flood disaster-relief-env:latest

# Run (earthquake scenario)
docker run -p 7860:7860 -e SCENARIO=earthquake disaster-relief-env:latest
```

---

## Deploy to Hugging Face Spaces

```bash
# Install HF CLI
pip install huggingface_hub

# Login
huggingface-cli login

# Push (replace with your username)
openenv push --repo-id your-username/disaster-relief-env
```

Or manually: create a new Space on huggingface.co with **Docker SDK**, push this repo, set `app_port=7860`.

---

## Baseline Results (greedy policy, seed=42)

Run locally with:
```bash
python baseline.py
```

| Task | Difficulty | Expected Score |
|---|---|---|
| Humanitarian Aid Distribution | Easy | ~0.85 |
| River Delta Flood | Medium | ~0.63 |
| Urban Earthquake | Hard | ~0.51 |

---

## Resources

- [OpenEnv GitHub](https://github.com/meta-pytorch/OpenEnv)
- [OpenEnv Course](https://github.com/raun/openenv-course)
- [Hackathon Page](https://www.scaler.com/school-of-technology/meta-pytorch-hackathon)
