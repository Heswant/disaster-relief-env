"""
Disaster Relief Supply Agent — Self-contained RL Environment
============================================================
A 10x10 grid where an AI agent drives a supply truck to deliver
food, water, and medicine to disaster victims.

Three scenarios: relief_camp (easy) | flood (medium) | earthquake (hard)
"""

import copy
import random
import uuid
from collections import deque
from enum import Enum
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────

class ActionType(str, Enum):
    DELIVER = "deliver"
    MOVE    = "move"
    RESTOCK = "restock"
    WAIT    = "wait"

class Direction(str, Enum):
    NORTH = "north"
    SOUTH = "south"
    EAST  = "east"
    WEST  = "west"

class NeedLevel(str, Enum):
    CRITICAL = "critical"
    HIGH     = "high"
    MODERATE = "moderate"
    LOW      = "low"
    NONE     = "none"

class ZoneType(str, Enum):
    VICTIM  = "victim"
    DEPOT   = "depot"
    BLOCKED = "blocked"
    EMPTY   = "empty"


# ── Data Models ────────────────────────────────────────────────

class ZoneInfo(BaseModel):
    zone_id: str
    x: int
    y: int
    zone_type: ZoneType
    victim_count: int = 0
    need_level: NeedLevel = NeedLevel.NONE
    needs: Dict[str, int] = Field(default_factory=dict)
    supplied: Dict[str, int] = Field(default_factory=dict)
    steps_without_aid: int = 0
    is_accessible: bool = True

class TruckStatus(BaseModel):
    current_zone_id: str
    x: int
    y: int
    inventory: Dict[str, int]
    capacity_remaining: int

class ReliefAction(BaseModel):
    action_type: ActionType
    target_zone_id: Optional[str] = None
    supply_type: Optional[str] = None
    quantity: Optional[int] = Field(default=None, ge=1, le=100)
    direction: Optional[Direction] = None

class ReliefObservation(BaseModel):
    scenario_name: str
    step_number: int
    max_steps: int
    zones: List[ZoneInfo]
    critical_zones: List[str]
    accessible_depots: List[str]
    truck: TruckStatus
    total_victims: int
    victims_served: int
    coverage_percent: float
    last_action_result: str = ""
    last_reward: float = 0.0
    is_complete: bool = False
    mission_success: bool = False


# ── Scenarios ──────────────────────────────────────────────────

def _flood_scenario():
    zones = {}
    zones["Z_0_9"] = {"type": "depot"}
    zones["Z_1_9"] = {"type": "depot"}
    for x in range(10):
        zones[f"Z_{x}_0"] = {"type": "blocked", "accessible": False}
        zones[f"Z_{x}_1"] = {"type": "blocked", "accessible": False}
    for x, y in [(4,2),(6,2),(2,4),(8,4)]:
        zones[f"Z_{x}_{y}"] = {"type": "blocked", "accessible": False}
    for x, y, v, n, needs in [
        (3,3,250,"critical",{"food":50,"water":80,"medicine":30}),
        (7,3,180,"critical",{"food":40,"water":60,"medicine":20}),
        (5,4,320,"high",    {"food":70,"water":100}),
        (2,5,150,"high",    {"food":30,"water":50,"medicine":40}),
        (8,5,200,"high",    {"food":45,"water":70,"medicine":10}),
        (4,6,90, "moderate",{"food":20,"water":30,"medicine":25}),
        (6,6,110,"moderate",{"food":25,"water":40,"medicine":15}),
        (1,7,60, "low",     {"food":15,"water":20,"medicine":5}),
        (9,7,75, "low",     {"food":18,"water":25,"medicine":8}),
    ]:
        zones[f"Z_{x}_{y}"] = {"type":"victim","victims":v,"need_level":n,"needs":needs}
    return {
        "name": "River Delta Flood",
        "disaster_type": "flood",
        "zones": zones,
        "truck_start": (0, 9),
        "max_steps": 50,
        "initial_inventory": {"food":200,"medicine":100,"water":300,"rescue_team":5},
        "truck_capacity": 200,
    }

def _earthquake_scenario():
    zones = {}
    for dx, dy in [(0,0),(9,0),(0,9),(9,9),(5,5)]:
        zones[f"Z_{dx}_{dy}"] = {"type": "depot"}
    for x, y in [(1,1),(2,2),(4,3),(6,1),(8,2),(3,5),(7,6),(1,7),(5,8),(8,7)]:
        zones[f"Z_{x}_{y}"] = {"type": "blocked", "accessible": False}
    for x, y, v, n, needs in [
        (2,1,400,"critical",{"food":60,"medicine":100,"water":80}),
        (5,2,300,"critical",{"food":50,"medicine":90, "water":70}),
        (7,3,250,"critical",{"food":40,"medicine":80, "water":60}),
        (3,4,200,"high",    {"food":45,"medicine":60, "water":50}),
        (8,5,180,"high",    {"food":35,"medicine":55, "water":45}),
        (2,6,150,"high",    {"food":30,"medicine":45, "water":40}),
        (6,7,120,"moderate",{"food":25,"medicine":35, "water":30}),
        (4,8,90, "moderate",{"food":20,"medicine":25, "water":25}),
        (7,8,70, "low",     {"food":15,"medicine":15, "water":20}),
    ]:
        zones[f"Z_{x}_{y}"] = {"type":"victim","victims":v,"need_level":n,"needs":needs}
    return {
        "name": "Urban Earthquake",
        "disaster_type": "earthquake",
        "zones": zones,
        "truck_start": (0, 0),
        "max_steps": 60,
        "initial_inventory": {"food":150,"medicine":200,"water":250,"rescue_team":8},
        "truck_capacity": 200,
    }

def _relief_camp_scenario():
    zones = {}
    zones["Z_5_5"] = {"type": "depot"}
    zones["Z_4_5"] = {"type": "depot"}
    for x, y, v, n, needs in [
        (3,3,100,"moderate",{"food":30,"water":50}),
        (7,3,80, "moderate",{"food":25,"water":40}),
        (3,7,90, "low",     {"food":20,"water":35}),
        (7,7,70, "low",     {"food":18,"water":30}),
        (5,2,120,"moderate",{"food":35,"water":55}),
    ]:
        zones[f"Z_{x}_{y}"] = {"type":"victim","victims":v,"need_level":n,"needs":needs}
    return {
        "name": "Humanitarian Aid Distribution Center",
        "disaster_type": "flood",
        "zones": zones,
        "truck_start": (5, 5),
        "max_steps": 70,
        "initial_inventory": {"food":300,"medicine":50,"water":400,"rescue_team":2},
        "truck_capacity": 300,
    }

SCENARIOS = {
    "relief_camp": _relief_camp_scenario,
    "flood":       _flood_scenario,
    "earthquake":  _earthquake_scenario,
}

def get_scenario(name: str) -> dict:
    if name not in SCENARIOS:
        raise ValueError(f"Unknown scenario '{name}'. Choose from: {list(SCENARIOS)}")
    return SCENARIOS[name]()


# ── Grid Engine ────────────────────────────────────────────────

DIRS = {
    Direction.NORTH: (0, -1),
    Direction.SOUTH: (0,  1),
    Direction.EAST:  (1,  0),
    Direction.WEST:  (-1, 0),
}

class DisasterGrid:
    def __init__(self, scenario: dict, rng_seed: int = 42):
        self.rng = random.Random(rng_seed)
        self._scenario = scenario
        self._grid: List[List[ZoneInfo]] = []
        self._truck_x = 0
        self._truck_y = 0
        self._build()

    def _build(self):
        self._grid = []
        for y in range(10):
            row = []
            for x in range(10):
                zid = f"Z_{x}_{y}"
                d = self._scenario["zones"].get(zid, {})
                row.append(ZoneInfo(
                    zone_id=zid, x=x, y=y,
                    zone_type=ZoneType(d.get("type", "empty")),
                    victim_count=d.get("victims", 0),
                    need_level=NeedLevel(d.get("need_level", "none")),
                    needs=d.get("needs", {}),
                    supplied={},
                    is_accessible=d.get("accessible", True),
                ))
            self._grid.append(row)
        sx, sy = self._scenario["truck_start"]
        self._truck_x, self._truck_y = sx, sy

    def zone(self, x, y) -> Optional[ZoneInfo]:
        if 0 <= x < 10 and 0 <= y < 10:
            return self._grid[y][x]
        return None

    def zone_by_id(self, zid: str) -> Optional[ZoneInfo]:
        try:
            _, x, y = zid.split("_")
            return self.zone(int(x), int(y))
        except Exception:
            return None

    def all_zones(self) -> List[ZoneInfo]:
        return [z for row in self._grid for z in row]

    def victim_zones(self) -> List[ZoneInfo]:
        return [z for z in self.all_zones() if z.zone_type == ZoneType.VICTIM]

    def depot_zones(self) -> List[ZoneInfo]:
        return [z for z in self.all_zones() if z.zone_type == ZoneType.DEPOT and z.is_accessible]

    def critical_zone_ids(self) -> List[str]:
        return [z.zone_id for z in self.victim_zones() if z.need_level == NeedLevel.CRITICAL]

    @property
    def truck_zone_id(self) -> str:
        return f"Z_{self._truck_x}_{self._truck_y}"

    @property
    def truck_position(self) -> Tuple[int, int]:
        return self._truck_x, self._truck_y

    def move_truck(self, direction: Direction) -> Tuple[bool, str]:
        dx, dy = DIRS[direction]
        nx, ny = self._truck_x + dx, self._truck_y + dy
        if not (0 <= nx < 10 and 0 <= ny < 10):
            return False, f"Cannot move {direction.value}: boundary"
        target = self.zone(nx, ny)
        if not target or not target.is_accessible:
            return False, f"Cannot move {direction.value}: {target.zone_id if target else '?'} is blocked"
        self._truck_x, self._truck_y = nx, ny
        return True, f"Moved {direction.value} to Z_{nx}_{ny}"

    def deliver(self, zone_id: str, supply: str, qty: int) -> Tuple[float, str]:
        z = self.zone_by_id(zone_id)
        if not z or z.zone_type != ZoneType.VICTIM:
            return 0.0, "Not a victim zone"
        if self.truck_zone_id != zone_id:
            return 0.0, f"Truck at {self.truck_zone_id}, not {zone_id}"
        needed = z.needs.get(supply, 0) - z.supplied.get(supply, 0)
        if needed <= 0:
            return 0.0, f"No {supply} needed at {zone_id}"
        actual = min(qty, needed)
        z.supplied[supply] = z.supplied.get(supply, 0) + actual
        z.steps_without_aid = 0
        ratio = actual / z.needs[supply]
        base = {NeedLevel.CRITICAL:1.0, NeedLevel.HIGH:0.7, NeedLevel.MODERATE:0.4, NeedLevel.LOW:0.2}.get(z.need_level, 0.1)
        reward = round(base * ratio, 3)
        self._update_need(z)
        return reward, f"Delivered {actual} {supply} to {zone_id} (reward={reward:.3f})"

    def _update_need(self, z: ZoneInfo):
        total = sum(z.needs.values())
        given = sum(z.supplied.get(k, 0) for k in z.needs)
        if total == 0:
            z.need_level = NeedLevel.NONE; return
        r = given / total
        if r >= 1.0:   z.need_level = NeedLevel.NONE
        elif r >= 0.7: z.need_level = NeedLevel.LOW
        elif r >= 0.4: z.need_level = NeedLevel.MODERATE
        elif r >= 0.1: z.need_level = NeedLevel.HIGH

    def advance_time(self) -> Dict[str, float]:
        penalties = {}
        for z in self.victim_zones():
            if z.need_level in (NeedLevel.CRITICAL, NeedLevel.HIGH):
                z.steps_without_aid += 1
                penalties[z.zone_id] = round(0.1 * (1.1 ** z.steps_without_aid), 3)
        if self.rng.random() < 0.15:
            candidates = [z for z in self.all_zones() if z.is_accessible and z.zone_type == ZoneType.EMPTY]
            if candidates:
                self.rng.choice(candidates).is_accessible = False
        return penalties

    def stats(self) -> dict:
        victims = self.victim_zones()
        total = sum(z.victim_count for z in victims)
        served = sum(z.victim_count for z in victims if z.need_level == NeedLevel.NONE)
        return {
            "total_victims": total,
            "victims_served": served,
            "coverage_percent": round(served / total * 100, 1) if total > 0 else 0.0,
        }


# ── Environment ────────────────────────────────────────────────

class DisasterReliefEnvironment:
    """
    RL Environment: reset() → step() loop until done.

    obs  = await env.reset()
    obs, reward, done, info = await env.step(action)
    state = env.state  (episode metadata)
    """

    def __init__(self, scenario_name: str = "flood", rng_seed: int = 42):
        self.scenario_name = scenario_name
        self.rng_seed = rng_seed
        self._grid: Optional[DisasterGrid] = None
        self._scenario: Optional[dict] = None
        self._inventory: Dict[str, int] = {}
        self._step_count = 0
        self._total_reward = 0.0
        self._is_complete = False

    async def reset(self) -> ReliefObservation:
        self._scenario = get_scenario(self.scenario_name)
        self._grid = DisasterGrid(self._scenario, rng_seed=self.rng_seed)
        self._inventory = copy.deepcopy(self._scenario["initial_inventory"])
        self._step_count = 0
        self._total_reward = 0.0
        self._is_complete = False
        return self._obs("Episode started! Deliver supplies to all victim zones.", 0.0)

    async def step(self, action: ReliefAction) -> Tuple[ReliefObservation, float, bool, dict]:
        if self._grid is None:
            raise RuntimeError("Call reset() first")

        self._step_count += 1
        delivery_reward = 0.0
        success = True
        msg = ""

        if action.action_type == ActionType.MOVE:
            if not action.direction:
                success, msg = False, "MOVE requires direction"
            else:
                success, msg = self._grid.move_truck(action.direction)

        elif action.action_type == ActionType.DELIVER:
            if not all([action.target_zone_id, action.supply_type, action.quantity]):
                success, msg = False, "DELIVER requires target_zone_id, supply_type, quantity"
            else:
                avail = self._inventory.get(action.supply_type, 0)
                if avail < action.quantity:
                    success, msg = False, f"Only {avail} {action.supply_type} in truck"
                else:
                    delivery_reward, msg = self._grid.deliver(
                        action.target_zone_id, action.supply_type, action.quantity
                    )
                    if delivery_reward > 0:
                        z = self._grid.zone_by_id(action.target_zone_id)
                        actual = min(action.quantity, z.needs.get(action.supply_type, 0))
                        self._inventory[action.supply_type] -= actual
                    else:
                        success = False

        elif action.action_type == ActionType.RESTOCK:
            cur = self._grid.zone_by_id(self._grid.truck_zone_id)
            if not cur or cur.zone_type != ZoneType.DEPOT:
                success, msg = False, "Truck must be at a depot to restock"
            else:
                cap = self._scenario["truck_capacity"]
                for s, max_amt in self._scenario["initial_inventory"].items():
                    cur_amt = self._inventory.get(s, 0)
                    added = min(max_amt // 2, cap - cur_amt)
                    self._inventory[s] = cur_amt + added
                msg = "Restocked at depot"

        elif action.action_type == ActionType.WAIT:
            msg = "Waited"

        # Time advance + penalties
        penalties = self._grid.advance_time()
        penalty_total = sum(penalties.values())

        # Step reward
        reward = delivery_reward - penalty_total
        if action.action_type == ActionType.WAIT: reward -= 0.1
        if not success: reward -= 0.05
        reward = round(reward, 4)
        self._total_reward += reward

        # Check done
        s = self._grid.stats()
        mission_done = s["coverage_percent"] >= 90.0
        timeout = self._step_count >= self._scenario["max_steps"]
        done = mission_done or timeout

        if done:
            cov = s["coverage_percent"] / 100.0
            speed = 1.0 - self._step_count / self._scenario["max_steps"]
            terminal = round(cov * 5.0 + max(0, speed) * 2.0 + (10.0 if cov >= 1.0 else 0.0), 3)
            reward += terminal
            self._total_reward += terminal
            self._is_complete = True

        return self._obs(msg, reward, done, mission_done), reward, done, {
            "episode_reward": round(self._total_reward, 4),
            "coverage_percent": s["coverage_percent"],
            "step": self._step_count,
            "action_success": success,
        }

    @property
    def state(self) -> dict:
        s = self._grid.stats() if self._grid else {}
        return {
            "scenario": self.scenario_name,
            "step_count": self._step_count,
            "total_reward": round(self._total_reward, 4),
            "is_complete": self._is_complete,
            "mission_success": s.get("coverage_percent", 0) >= 90.0,
            "coverage_percent": s.get("coverage_percent", 0.0),
            "victims_served": s.get("victims_served", 0),
        }

    def _obs(self, msg: str, reward: float, done=False, success=False) -> ReliefObservation:
        s = self._grid.stats() if self._grid else {}
        tx, ty = self._grid.truck_position if self._grid else (0, 0)
        cap = self._scenario.get("truck_capacity", 200) if self._scenario else 200
        used = sum(self._inventory.values())
        return ReliefObservation(
            scenario_name=self._scenario.get("name", "") if self._scenario else "",
            step_number=self._step_count,
            max_steps=self._scenario.get("max_steps", 50) if self._scenario else 50,
            zones=self._grid.all_zones() if self._grid else [],
            critical_zones=self._grid.critical_zone_ids() if self._grid else [],
            accessible_depots=[z.zone_id for z in self._grid.depot_zones()] if self._grid else [],
            truck=TruckStatus(
                current_zone_id=self._grid.truck_zone_id if self._grid else "",
                x=tx, y=ty,
                inventory=copy.deepcopy(self._inventory),
                capacity_remaining=max(0, cap - used),
            ),
            total_victims=s.get("total_victims", 0),
            victims_served=s.get("victims_served", 0),
            coverage_percent=s.get("coverage_percent", 0.0),
            last_action_result=msg,
            last_reward=round(reward, 4),
            is_complete=done,
            mission_success=success,
        )
