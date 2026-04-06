"""
Disaster Relief Supply Agent — FastAPI Server
=============================================
Endpoints:
  POST /reset     — start a new episode
  POST /step      — execute one action
  GET  /state     — current episode metadata
  GET  /health    — health check
  GET  /tasks     — list all 3 tasks + action schema
  GET  /grader    — score for current episode (0.0–1.0)
  GET  /baseline  — run greedy agent on all 3 tasks

Run:  uvicorn app:app --host 0.0.0.0 --port 7860 --reload
Docs: http://localhost:7860/docs
"""

import asyncio
from collections import deque
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional

from environment import (
    DisasterReliefEnvironment, ReliefAction,
    ActionType, Direction, NeedLevel, ZoneType,
)

# ── App + persistent environment ──────────────────────────────
app = FastAPI(title="Disaster Relief Supply Agent")
env = DisasterReliefEnvironment(scenario_name="flood", rng_seed=42)


# ── Request models ─────────────────────────────────────────────
class ResetRequest(BaseModel):
    scenario: Optional[str] = None   # flood | earthquake | relief_camp
    seed: Optional[int] = None

class StepRequest(BaseModel):
    action: ReliefAction


# ══════════════════════════════════════════════════════════════
# STANDARD ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/reset")
async def reset(req: ResetRequest = None):
    """Start a new episode. Optionally pick a scenario and seed."""
    global env
    scenario = (req.scenario if req else None) or "flood"
    seed     = (req.seed     if req else None) or 42
    env = DisasterReliefEnvironment(scenario_name=scenario, rng_seed=seed)
    obs = await env.reset()
    return obs.model_dump()


@app.post("/step")
async def step(req: StepRequest):
    """Execute one action. Must call /reset first."""
    if env._grid is None:
        raise HTTPException(400, "Call /reset before /step")
    obs, reward, done, info = await env.step(req.action)
    return {"observation": obs.model_dump(), "reward": reward, "done": done, "info": info}


@app.get("/state")
async def get_state():
    """Current episode metadata (step count, coverage, score)."""
    return env.state


# ══════════════════════════════════════════════════════════════
# HACKATHON ENDPOINTS
# ══════════════════════════════════════════════════════════════

TASKS = [
    {
        "task_id": "easy",
        "name": "Humanitarian Aid Distribution Center",
        "scenario": "relief_camp",
        "difficulty": "easy",
        "max_steps": 70,
        "description": "Open field, no blockages. Deliver to 5 zones in 70 steps.",
    },
    {
        "task_id": "medium",
        "name": "River Delta Flood — Day 1",
        "scenario": "flood",
        "difficulty": "medium",
        "max_steps": 50,
        "description": "Flood blocks north. 9 victim zones, 2 critical, 50 steps.",
    },
    {
        "task_id": "hard",
        "name": "Urban Earthquake — 6 Hours Post-Event",
        "scenario": "earthquake",
        "difficulty": "hard",
        "max_steps": 60,
        "description": "Rubble everywhere. 3 critical zones, 5 depots, 60 steps.",
    },
]

ACTION_SCHEMA = {
    "move":    {"required": ["action_type", "direction"], "direction": ["north","south","east","west"]},
    "deliver": {"required": ["action_type", "target_zone_id", "supply_type", "quantity"],
                "supply_type": ["food","water","medicine","rescue_team"], "quantity": "1-100"},
    "restock": {"required": ["action_type"], "note": "Truck must be at a depot"},
    "wait":    {"required": ["action_type"]},
}


@app.get("/tasks")
async def get_tasks():
    return {"tasks": TASKS, "action_schema": ACTION_SCHEMA, "total_tasks": len(TASKS)}


@app.get("/grader")
async def get_grader():
    """Normalized score 0.0–1.0 for the current episode."""
    s = env.state
    cov   = s["coverage_percent"] / 100.0
    max_s = env._scenario["max_steps"] if env._scenario else 60
    speed = max(0.0, 1.0 - s["step_count"] / max_s)
    score = round(0.8 * cov + 0.2 * speed, 4)
    return {
        "score": score,
        "coverage_percent": s["coverage_percent"],
        "victims_served": s["victims_served"],
        "steps_used": s["step_count"],
        "is_complete": s["is_complete"],
        "mission_success": s["mission_success"],
        "breakdown": {"coverage": round(0.8*cov,4), "speed": round(0.2*speed,4)},
    }


@app.get("/baseline")
async def get_baseline():
    """Run greedy agent on all 3 tasks. Returns reproducible baseline scores."""
    results = {}
    for task in TASKS:
        score = await _greedy_episode(task["scenario"], task["max_steps"])
        results[task["task_id"]] = {"score": score, "difficulty": task["difficulty"]}
    return {"baseline_scores": results, "policy": "BFS greedy", "seed": 42}


# ── Greedy baseline agent ──────────────────────────────────────

async def _greedy_episode(scenario: str, max_steps: int) -> float:
    e = DisasterReliefEnvironment(scenario_name=scenario, rng_seed=42)
    obs = await e.reset()
    for _ in range(max_steps):
        if obs.is_complete: break
        obs, _, done, _ = await e.step(_greedy_action(obs))
        if done: break
    s = e.state
    cov   = s["coverage_percent"] / 100.0
    speed = max(0.0, 1.0 - s["step_count"] / max_steps)
    return round(0.8 * cov + 0.2 * speed, 4)


def _greedy_action(obs) -> ReliefAction:
    truck = obs.truck
    cur = next((z for z in obs.zones if z.zone_id == truck.current_zone_id), None)

    # Deliver if at a victim zone with needs
    if cur and cur.zone_type == ZoneType.VICTIM:
        for supply, needed in cur.needs.items():
            left = needed - cur.supplied.get(supply, 0)
            avail = truck.inventory.get(supply, 0)
            if left > 0 and avail > 0:
                return ReliefAction(action_type=ActionType.DELIVER,
                                    target_zone_id=cur.zone_id, supply_type=supply,
                                    quantity=min(left, avail, 50))

    total_inv = sum(truck.inventory.values())
    total_cap = total_inv + truck.capacity_remaining
    low = (total_inv / total_cap < 0.25) if total_cap > 0 else False

    # Restock if at depot and low
    if cur and cur.zone_type == ZoneType.DEPOT and low:
        return ReliefAction(action_type=ActionType.RESTOCK)

    # Navigate to nearest depot if critically low
    if low and obs.accessible_depots:
        dx, dy = _coords(min(obs.accessible_depots,
                             key=lambda z: _dist(truck.x, truck.y, *_coords(z))))
        return ReliefAction(action_type=ActionType.MOVE,
                            direction=_bfs(obs, truck.x, truck.y, dx, dy))

    # Navigate to nearest unserved victim zone (critical first)
    for level in [NeedLevel.CRITICAL, NeedLevel.HIGH, NeedLevel.MODERATE, NeedLevel.LOW]:
        targets = [z for z in obs.zones if z.zone_type == ZoneType.VICTIM
                   and z.need_level == level and z.is_accessible]
        if targets:
            best = min(targets, key=lambda z: _dist(truck.x, truck.y, z.x, z.y))
            return ReliefAction(action_type=ActionType.MOVE,
                                direction=_bfs(obs, truck.x, truck.y, best.x, best.y))

    return ReliefAction(action_type=ActionType.WAIT)


def _dist(x1,y1,x2,y2): return abs(x1-x2)+abs(y1-y2)
def _coords(zid): _, x, y = zid.split("_"); return int(x), int(y)

def _bfs(obs, fx, fy, tx, ty) -> Direction:
    """BFS shortest path avoiding blocked zones."""
    passable = {(z.x, z.y) for z in obs.zones if z.is_accessible}
    passable.add((fx, fy))
    steps = [(0,-1,Direction.NORTH),(0,1,Direction.SOUTH),(1,0,Direction.EAST),(-1,0,Direction.WEST)]
    q, seen = deque([(fx, fy, None)]), {(fx, fy)}
    while q:
        x, y, first = q.popleft()
        if x == tx and y == ty:
            return first or Direction.NORTH
        for dx, dy, d in steps:
            nx, ny = x+dx, y+dy
            if (nx,ny) not in seen and (nx,ny) in passable:
                seen.add((nx,ny))
                q.append((nx, ny, first or d))
    # Fallback: direct direction
    dx, dy = tx-fx, ty-fy
    if abs(dx) >= abs(dy): return Direction.EAST if dx>0 else Direction.WEST
    return Direction.SOUTH if dy>0 else Direction.NORTH
