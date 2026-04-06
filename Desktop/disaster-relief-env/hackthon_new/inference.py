"""
inference.py — LLM Agent for Disaster Relief Supply Agent
==========================================================
Runs an LLM (via OpenAI-compatible API) on all 3 tasks.
Falls back to greedy policy when LLM fails.

Required env vars (set in .env):
  API_BASE_URL  — e.g. https://api.groq.com/openai/v1
  HF_TOKEN      — your API key
  MODEL_NAME    — e.g. llama-3.1-8b-instant

Usage: python inference.py
"""

import asyncio, json, os, sys, textwrap
from collections import deque
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

import httpx
from openai import OpenAI
from environment import (
    DisasterReliefEnvironment, ReliefAction,
    ActionType, Direction, NeedLevel, ZoneType,
)

# ── Config (checklist-compliant) ──────────────────────────────
API_BASE_URL     = os.getenv("API_BASE_URL", "https://router.huggingface.co/v1")
MODEL_NAME       = os.getenv("MODEL_NAME",   "Qwen/Qwen2.5-72B-Instruct")
HF_TOKEN         = os.getenv("HF_TOKEN")          # no default — must be set
LOCAL_IMAGE_NAME = os.getenv("LOCAL_IMAGE_NAME")  # optional, for from_docker_image()
RNG_SEED         = int(os.getenv("RNG_SEED", "42"))

TASKS = [
    ("easy",   "relief_camp"),
    ("medium", "flood"),
    ("hard",   "earthquake"),
]

# All LLM calls use the OpenAI client configured via these variables
client = OpenAI(
    base_url=API_BASE_URL,
    api_key=HF_TOKEN,
    http_client=httpx.Client(verify=False),
)

# ── Logging (required hackathon format) ───────────────────────
def log_start(task, model):
    print(f"[START] task={task} env=disaster_relief model={model}", flush=True)

def log_step(step, action, reward, done, error=None):
    print(f"[STEP] step={step} action={action} reward={reward:.2f} done={str(done).lower()} error={error or 'null'}", flush=True)

def log_end(success, steps, score, rewards):
    print(f"[END] success={str(success).lower()} steps={steps} score={score:.3f} rewards={','.join(f'{r:.2f}' for r in rewards)}", flush=True)


# ── LLM prompt ────────────────────────────────────────────────
SYSTEM = textwrap.dedent("""
    You control a disaster relief truck on a 10x10 grid.
    Goal: deliver food, water, medicine to all victim zones.

    Return ONLY a JSON action — no explanation, no markdown.

    Formats:
      {"action_type": "move",    "direction": "north|south|east|west"}
      {"action_type": "deliver", "target_zone_id": "Z_X_Y", "supply_type": "food|water|medicine", "quantity": N}
      {"action_type": "restock"}
      {"action_type": "wait"}

    Rules: serve CRITICAL zones first, restock when inventory < 25%, never hit blocked zones.
""").strip()

def _prompt(obs) -> str:
    truck = obs.truck
    unserved = sorted(
        [z for z in obs.zones if z.zone_type == ZoneType.VICTIM and z.need_level != NeedLevel.NONE],
        key=lambda z: [NeedLevel.CRITICAL, NeedLevel.HIGH, NeedLevel.MODERATE, NeedLevel.LOW].index(z.need_level)
                      if z.need_level in [NeedLevel.CRITICAL, NeedLevel.HIGH, NeedLevel.MODERATE, NeedLevel.LOW] else 9
    )
    zones_text = "\n".join(
        f"  {z.zone_id} [{z.need_level.value.upper()}] pos=({z.x},{z.y}) "
        f"needs={{{', '.join(f'{k}: {z.needs[k]-z.supplied.get(k,0)}' for k in z.needs if z.needs[k]-z.supplied.get(k,0)>0)}}}"
        for z in unserved[:8]
    ) or "  (all served!)"
    depots = ", ".join(obs.accessible_depots[:4]) or "none"
    return (
        f"Step {obs.step_number}/{obs.max_steps} | Coverage: {obs.coverage_percent:.1f}%\n"
        f"Truck: pos=({truck.x},{truck.y}) zone={truck.current_zone_id}\n"
        f"  inventory={dict(truck.inventory)} capacity_left={truck.capacity_remaining}\n\n"
        f"Unserved zones (priority order):\n{zones_text}\n\n"
        f"Depots: {depots}\n\nChoose the best action:"
    )

def _llm_action(obs) -> tuple[ReliefAction, Optional[str]]:
    try:
        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role":"system","content":SYSTEM}, {"role":"user","content":_prompt(obs)}],
            max_tokens=100, temperature=0.0,
        )
        raw = resp.choices[0].message.content.strip().strip("```json").strip("```").strip()
        return ReliefAction(**json.loads(raw)), None
    except Exception as e:
        return _greedy_fallback(obs), str(e)

def _greedy_fallback(obs) -> ReliefAction:
    truck = obs.truck
    cur = next((z for z in obs.zones if z.zone_id == truck.current_zone_id), None)
    if cur and cur.zone_type == ZoneType.VICTIM:
        for s, needed in cur.needs.items():
            left = needed - cur.supplied.get(s, 0)
            avail = truck.inventory.get(s, 0)
            if left > 0 and avail > 0:
                return ReliefAction(action_type=ActionType.DELIVER, target_zone_id=cur.zone_id,
                                    supply_type=s, quantity=min(left, avail, 50))
    total = sum(truck.inventory.values())
    cap = total + truck.capacity_remaining
    low = (total / cap < 0.25) if cap > 0 else False
    if cur and cur.zone_type == ZoneType.DEPOT and low:
        return ReliefAction(action_type=ActionType.RESTOCK)
    if low and obs.accessible_depots:
        dx, dy = _coords(min(obs.accessible_depots, key=lambda z: _dist(truck.x,truck.y,*_coords(z))))
        return ReliefAction(action_type=ActionType.MOVE, direction=_bfs(obs,truck.x,truck.y,dx,dy))
    for level in [NeedLevel.CRITICAL, NeedLevel.HIGH, NeedLevel.MODERATE, NeedLevel.LOW]:
        targets = [z for z in obs.zones if z.zone_type==ZoneType.VICTIM and z.need_level==level and z.is_accessible]
        if targets:
            best = min(targets, key=lambda z: _dist(truck.x,truck.y,z.x,z.y))
            return ReliefAction(action_type=ActionType.MOVE, direction=_bfs(obs,truck.x,truck.y,best.x,best.y))
    return ReliefAction(action_type=ActionType.WAIT)

def _dist(x1,y1,x2,y2): return abs(x1-x2)+abs(y1-y2)
def _coords(zid): _,x,y=zid.split("_"); return int(x),int(y)
def _bfs(obs, fx, fy, tx, ty) -> Direction:
    passable = {(z.x,z.y) for z in obs.zones if z.is_accessible}
    passable.add((fx,fy))
    moves = [(0,-1,Direction.NORTH),(0,1,Direction.SOUTH),(1,0,Direction.EAST),(-1,0,Direction.WEST)]
    q, seen = deque([(fx,fy,None)]), {(fx,fy)}
    while q:
        x,y,first = q.popleft()
        if x==tx and y==ty: return first or Direction.NORTH
        for dx,dy,d in moves:
            nx,ny=x+dx,y+dy
            if (nx,ny) not in seen and (nx,ny) in passable:
                seen.add((nx,ny)); q.append((nx,ny,first or d))
    dx,dy=tx-fx,ty-fy
    if abs(dx)>=abs(dy): return Direction.EAST if dx>0 else Direction.WEST
    return Direction.SOUTH if dy>0 else Direction.NORTH


# ── Episode runner ─────────────────────────────────────────────
async def run_episode(task_id: str, scenario: str) -> float:
    log_start(task_id, MODEL_NAME)
    env = DisasterReliefEnvironment(scenario_name=scenario, rng_seed=RNG_SEED)
    rewards: List[float] = []
    steps = 0

    try:
        obs = await env.reset()
        for step_num in range(1, obs.max_steps + 1):
            if obs.is_complete: break
            action, err = _llm_action(obs)
            obs, reward, done, _ = await env.step(action)
            rewards.append(reward)
            steps = step_num
            log_step(step_num, action.action_type.value, reward, done, err)
            if done: break

        s = env.state
        cov   = s["coverage_percent"] / 100.0
        speed = max(0.0, 1.0 - s["step_count"] / obs.max_steps)
        score = round(0.8*cov + 0.2*speed, 3)
        log_end(score >= 0.5, steps, score, rewards)
        return score
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        log_end(False, steps, 0.0, rewards)
        return 0.0


async def main():
    if not HF_TOKEN:
        print("ERROR: HF_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    scores = []
    for task_id, scenario in TASKS:
        scores.append(await run_episode(task_id, scenario))
    avg = round(sum(scores)/len(scores), 3)
    print(f"\n[SUMMARY] average_score={avg:.3f} scores={','.join(f'{s:.3f}' for s in scores)}")

if __name__ == "__main__":
    asyncio.run(main())
