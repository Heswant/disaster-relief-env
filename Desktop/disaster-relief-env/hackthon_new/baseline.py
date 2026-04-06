"""
Baseline Inference Script — Disaster Relief Supply Agent
Runs a greedy agent on all 3 tasks and prints reproducible scores.

Usage:
    python baseline.py
    python baseline.py --scenario flood
"""

import asyncio
import argparse
from disaster_relief_env.environment import DisasterReliefEnvironment
from disaster_relief_env.models import ReliefAction, ActionType, Direction, NeedLevel, ZoneType

RNG_SEED = 42

TASKS = [
    ("easy",   "relief_camp"),
    ("medium", "flood"),
    ("hard",   "earthquake"),
]


# ─── Greedy Policy ────────────────────────────────────────────

def greedy_action(obs) -> ReliefAction:
    truck = obs.truck
    current = next((z for z in obs.zones if z.zone_id == truck.current_zone_id), None)

    # Deliver if at a victim zone with remaining needs
    if current and current.zone_type == ZoneType.VICTIM:
        for supply, needed in current.needs.items():
            remaining = needed - current.supplied.get(supply, 0)
            available = truck.inventory.get(supply, 0)
            if remaining > 0 and available > 0:
                return ReliefAction(
                    action_type=ActionType.DELIVER,
                    target_zone_id=current.zone_id,
                    supply_type=supply,
                    quantity=min(remaining, available, 50),
                )

    # Restock if at depot and low inventory
    total_inv = sum(truck.inventory.values())
    total_cap = total_inv + truck.capacity_remaining
    low = (total_inv / total_cap < 0.25) if total_cap > 0 else False

    if current and current.zone_type == ZoneType.DEPOT and low:
        return ReliefAction(action_type=ActionType.RESTOCK)

    # Move to nearest depot when critically low
    if low and obs.accessible_depots:
        nearest = min(obs.accessible_depots,
                      key=lambda zid: _dist(truck.x, truck.y, *_coords(zid)))
        dx, dy = _coords(nearest)
        return ReliefAction(action_type=ActionType.MOVE,
                            direction=_bfs_direction(obs, truck.x, truck.y, dx, dy))

    # Move toward best unserved victim zone
    for level in [NeedLevel.CRITICAL, NeedLevel.HIGH, NeedLevel.MODERATE, NeedLevel.LOW]:
        targets = [z for z in obs.zones
                   if z.zone_type == ZoneType.VICTIM
                   and z.need_level == level
                   and z.is_accessible]
        if targets:
            best = min(targets, key=lambda z: _dist(truck.x, truck.y, z.x, z.y))
            return ReliefAction(action_type=ActionType.MOVE,
                                direction=_bfs_direction(obs, truck.x, truck.y, best.x, best.y))

    return ReliefAction(action_type=ActionType.WAIT)


def _dist(x1, y1, x2, y2): return abs(x1 - x2) + abs(y1 - y2)
def _coords(zid): _, x, y = zid.split("_"); return int(x), int(y)
def _toward(fx, fy, tx, ty) -> Direction:
    dx, dy = tx - fx, ty - fy
    if abs(dx) >= abs(dy):
        return Direction.EAST if dx > 0 else Direction.WEST
    return Direction.SOUTH if dy > 0 else Direction.NORTH


def _bfs_direction(obs, fx: int, fy: int, tx: int, ty: int) -> Direction:
    """BFS to find first step of shortest path avoiding blocked zones."""
    from collections import deque
    accessible = {(z.x, z.y) for z in obs.zones if z.is_accessible}
    accessible.add((fx, fy))  # current position is always passable

    moves = [(0, -1, Direction.NORTH), (0, 1, Direction.SOUTH),
             (1, 0, Direction.EAST),  (-1, 0, Direction.WEST)]

    queue = deque([(fx, fy, None)])  # (x, y, first_direction)
    visited = {(fx, fy)}

    while queue:
        x, y, first_dir = queue.popleft()
        if x == tx and y == ty:
            return first_dir if first_dir is not None else Direction.NORTH

        for dx, dy, d in moves:
            nx, ny = x + dx, y + dy
            if (nx, ny) not in visited and (nx, ny) in accessible:
                visited.add((nx, ny))
                queue.append((nx, ny, first_dir if first_dir is not None else d))

    # No path found — fall back to Manhattan
    return _toward(fx, fy, tx, ty)


# ─── Episode Runner ───────────────────────────────────────────

async def run_episode(scenario_name: str) -> dict:
    env = DisasterReliefEnvironment(scenario_name=scenario_name,
                                    use_llm_grading=False, rng_seed=RNG_SEED)
    obs = await env.reset_async()
    total_reward = 0.0

    for step in range(obs.max_steps):
        if obs.is_complete:
            break
        action = greedy_action(obs)
        obs, reward, done, _ = await env.step_async(action)
        total_reward += reward
        if done:
            break

    state = env.state
    coverage = state.coverage_percent / 100.0
    speed = max(0.0, 1.0 - state.step_count / obs.max_steps)
    score = round(min(1.0, 0.8 * coverage + 0.2 * speed), 4)

    return {
        "scenario": scenario_name,
        "score": score,
        "coverage_percent": state.coverage_percent,
        "victims_saved": state.victims_saved,
        "steps_used": state.step_count,
        "total_reward": round(total_reward, 4),
        "mission_success": state.mission_success,
    }


# ─── Main ─────────────────────────────────────────────────────

async def main(scenario: str = None):
    tasks = [(d, s) for d, s in TASKS if scenario is None or s == scenario]

    print("\n=== Disaster Relief Supply Agent — Baseline Scores ===\n")
    all_scores = []

    for difficulty, scenario_name in tasks:
        result = await run_episode(scenario_name)
        all_scores.append(result["score"])
        status = "SUCCESS" if result["mission_success"] else "TIMEOUT"
        print(f"[{difficulty.upper():6}] {scenario_name:12} | "
              f"score={result['score']:.4f} | "
              f"coverage={result['coverage_percent']:5.1f}% | "
              f"steps={result['steps_used']:3d} | "
              f"victims_saved={result['victims_saved']:4d} | "
              f"{status}")

    if len(all_scores) > 1:
        print(f"\nAverage baseline score: {sum(all_scores)/len(all_scores):.4f}")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default=None,
                        choices=["relief_camp", "flood", "earthquake"],
                        help="Run baseline for a single scenario only")
    args = parser.parse_args()
    asyncio.run(main(args.scenario))
